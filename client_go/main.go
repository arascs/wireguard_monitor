package main

import (
	"fmt"
	"os"
	"strconv"
	"sync"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/layout"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
	"image/color"
)

// ─── App State ───────────────────────────────────────────────────────────────

type state struct {
	mu         sync.RWMutex
	tokens     map[string]string // "ip:port" → JWT
	usernames  map[string]string // "ip:port" → username
	enrolled   map[string]bool   // "ip:port" → enrolled
	connected  map[string]bool   // "ip:port" → wg connected
	deviceName string
	machineID  string
	heartbeat  *HeartbeatManager
	hbCount    int
	hbLastAt   time.Time
	hbFailed   bool
	hbReason   string
}

func newState() *state {
	return &state{
		tokens:    make(map[string]string),
		usernames: make(map[string]string),
		enrolled:  make(map[string]bool),
		connected: make(map[string]bool),
		heartbeat: NewHeartbeatManager(),
	}
}

func skey(ip string, port int) string { return fmt.Sprintf("%s:%d", ip, port) }

// ─── Globals ──────────────────────────────────────────────────────────────────

var (
	myApp    fyne.App
	myWin    fyne.Window
	st       *state
	listBox  *fyne.Container // holds server card rows
	hbLabel  *widget.Label   // heartbeat status label at the bottom
)

// ─── Main ─────────────────────────────────────────────────────────────────────

func main() {
	if os.Getuid() != 0 {
		a := app.New()
		w := a.NewWindow("WireGuard Client – Error")
		w.SetContent(widget.NewLabel("⚠  Must be run as root (sudo)"))
		w.ShowAndRun()
		return
	}

	myApp = app.New()
	myApp.Settings().SetTheme(theme.DarkTheme())

	st = newState()
	st.deviceName = getDeviceName()
	st.machineID = getMachineID()

	myWin = myApp.NewWindow("🔒 WireGuard VPN Client")
	myWin.Resize(fyne.NewSize(860, 560))

	myWin.SetContent(buildUI())
	myWin.SetOnClosed(func() {
		st.heartbeat.Stop()
	})

	// Background: refresh connection status every 30s
	go func() {
		refreshConnectionStatus()
		for range time.Tick(30 * time.Second) {
			refreshConnectionStatus()
		}
	}()

	myWin.ShowAndRun()
}

// ─── UI Builder ───────────────────────────────────────────────────────────────

func buildUI() fyne.CanvasObject {
	// Header
	title := canvas.NewText("WireGuard VPN Client", color.NRGBA{R: 99, G: 179, B: 237, A: 255})
	title.TextStyle = fyne.TextStyle{Bold: true}
	title.TextSize = 20

	deviceInfo := widget.NewLabel(fmt.Sprintf("Device: %s  |  Machine ID: %s", st.deviceName, st.machineID))
	deviceInfo.TextStyle = fyne.TextStyle{Italic: true}

	addBtn := widget.NewButtonWithIcon("Add Server", theme.ContentAddIcon(), showAddServerDialog)
	addBtn.Importance = widget.HighImportance

	headerLeft := container.NewVBox(title, deviceInfo)
	header := container.NewBorder(nil, nil, headerLeft, addBtn)
	headerPad := container.NewPadded(header)

	sep := widget.NewSeparator()

	// Column headers
	colHeader := container.New(layout.NewGridLayoutWithColumns(5),
		boldLabel("Server Name"),
		boldLabel("Address"),
		boldLabel("Status"),
		boldLabel("Heartbeat"),
		boldLabel("Actions"),
	)
	colHeaderPad := container.NewPadded(colHeader)

	// Server list
	listBox = container.NewVBox()
	scroll := container.NewVScroll(listBox)

	// Bottom status bar
	hbLabel = widget.NewLabel("💤  No active VPN connection")
	hbLabel.TextStyle = fyne.TextStyle{Italic: true}
	statusBar := container.NewPadded(hbLabel)

	// Assemble
	refreshServerList()
	return container.NewBorder(
		container.NewVBox(headerPad, sep, colHeaderPad, widget.NewSeparator()),
		container.NewVBox(widget.NewSeparator(), statusBar),
		nil, nil,
		scroll,
	)
}

func boldLabel(text string) *widget.Label {
	l := widget.NewLabel(text)
	l.TextStyle = fyne.TextStyle{Bold: true}
	return l
}

// ─── Server List ──────────────────────────────────────────────────────────────

func refreshServerList() {
	servers, err := loadServers()
	if err != nil {
		showError(fmt.Errorf("load servers: %w", err))
		return
	}

	var rows []fyne.CanvasObject
	if len(servers) == 0 {
		rows = append(rows, container.NewPadded(
			widget.NewLabel("No servers configured. Click \"Add Server\" to get started."),
		))
	} else {
		for _, s := range servers {
			rows = append(rows, buildServerRow(s))
			rows = append(rows, widget.NewSeparator())
		}
	}

	listBox.Objects = rows
	listBox.Refresh()
	updateHeartbeatLabel()
}

func buildServerRow(s Server) fyne.CanvasObject {
	k := skey(s.IP, s.Port)

	st.mu.RLock()
	isConnected := st.connected[k]
	hasToken := st.tokens[k] != ""
	isEnrolled := st.enrolled[k]
	st.mu.RUnlock()

	// Status cell
	var statusText string
	var statusColor color.Color
	if isConnected {
		statusText = "● Connected"
		statusColor = color.NRGBA{R: 72, G: 199, B: 116, A: 255}
	} else {
		statusText = "● Disconnected"
		statusColor = color.NRGBA{R: 255, G: 100, B: 100, A: 255}
	}
	statusLbl := canvas.NewText(statusText, statusColor)
	statusLbl.TextStyle = fyne.TextStyle{Bold: true}

	// Heartbeat cell
	hbText := "—"
	st.mu.RLock()
	if isConnected {
		if st.hbFailed {
			hbText = "💀 Failed"
		} else if st.hbCount > 0 {
			hbText = fmt.Sprintf("💓 #%d  %s", st.hbCount, st.hbLastAt.Format("15:04:05"))
		} else {
			hbText = "💓 Starting…"
		}
	}
	st.mu.RUnlock()
	hbCell := widget.NewLabel(hbText)

	// Action buttons
	var actionBtns []fyne.CanvasObject
	if !hasToken {
		loginBtn := widget.NewButtonWithIcon("Login", theme.LoginIcon(), func() {
			showLoginDialog(s)
		})
		loginBtn.Importance = widget.MediumImportance
		actionBtns = append(actionBtns, loginBtn)
	} else {
		if isConnected {
			discBtn := widget.NewButtonWithIcon("Disconnect", theme.MediaStopIcon(), func() {
				doDisconnect(s)
			})
			discBtn.Importance = widget.DangerImportance
			actionBtns = append(actionBtns, discBtn)
		} else if isEnrolled {
			connBtn := widget.NewButtonWithIcon("Connect", theme.MediaPlayIcon(), func() {
				doConnect(s)
			})
			connBtn.Importance = widget.HighImportance
			actionBtns = append(actionBtns, connBtn)
		} else {
			enrollBtn := widget.NewButtonWithIcon("Enroll", theme.DocumentIcon(), func() {
				doEnroll(s)
			})
			actionBtns = append(actionBtns, enrollBtn)
		}
		logoutBtn := widget.NewButton("Logout", func() {
			doLogout(s)
		})
		actionBtns = append(actionBtns, logoutBtn)
	}
	delBtn := widget.NewButtonWithIcon("", theme.DeleteIcon(), func() {
		showConfirmDelete(s)
	})
	delBtn.Importance = widget.DangerImportance
	actionBtns = append(actionBtns, delBtn)

	actionsBox := container.NewHBox(actionBtns...)

	row := container.New(layout.NewGridLayoutWithColumns(5),
		widget.NewLabel(s.Name),
		widget.NewLabel(fmt.Sprintf("%s:%d", s.IP, s.Port)),
		container.NewPadded(statusLbl),
		hbCell,
		actionsBox,
	)
	return container.NewPadded(row)
}

// ─── Dialogs ──────────────────────────────────────────────────────────────────

func showAddServerDialog() {
	nameEntry := widget.NewEntry()
	nameEntry.SetPlaceHolder("My VPN Server")
	ipEntry := widget.NewEntry()
	ipEntry.SetPlaceHolder("192.168.1.10")
	portEntry := widget.NewEntry()
	portEntry.SetText("3000")

	items := []*widget.FormItem{
		{Text: "Name", Widget: nameEntry},
		{Text: "Server IP", Widget: ipEntry},
		{Text: "Port", Widget: portEntry},
	}
	dialog.ShowForm("Add VPN Server", "Add", "Cancel", items, func(ok bool) {
		if !ok {
			return
		}
		port, err := strconv.Atoi(portEntry.Text)
		if err != nil || port <= 0 {
			showError(fmt.Errorf("invalid port"))
			return
		}
		if err := addServer(nameEntry.Text, ipEntry.Text, port); err != nil {
			showError(err)
			return
		}
		refreshServerList()
	}, myWin)
}

func showLoginDialog(s Server) {
	userEntry := widget.NewEntry()
	userEntry.SetPlaceHolder("username")
	passEntry := widget.NewPasswordEntry()

	items := []*widget.FormItem{
		{Text: "Username", Widget: userEntry},
		{Text: "Password", Widget: passEntry},
	}
	dialog.ShowForm(fmt.Sprintf("Login to %s", s.Name), "Login", "Cancel", items, func(ok bool) {
		if !ok {
			return
		}
		prog := dialog.NewCustomWithoutButtons("Logging in…", widget.NewProgressBarInfinite(), myWin)
		prog.Show()
		go func() {
			token, err := apiLogin(s.IP, s.Port, userEntry.Text, passEntry.Text)
			prog.Hide()
			if err != nil {
				showError(fmt.Errorf("login failed: %w", err))
				return
			}
			st.mu.Lock()
			k := skey(s.IP, s.Port)
			st.tokens[k] = token
			st.usernames[k] = userEntry.Text
			delete(st.enrolled, k) // clear cache
			st.mu.Unlock()

			// Check enrollment in background
			enrolled, _ := apiCheckEnroll(s.IP, s.Port, token, userEntry.Text, st.deviceName)
			st.mu.Lock()
			st.enrolled[k] = enrolled
			st.mu.Unlock()

			refreshServerList()
		}()
	}, myWin)
}

func showConfirmDelete(s Server) {
	dialog.ShowConfirm(
		"Delete Server",
		fmt.Sprintf("Delete server \"%s\" (%s:%d)?", s.Name, s.IP, s.Port),
		func(ok bool) {
			if !ok {
				return
			}
			doLogout(s) // clear token
			if err := deleteServer(s.IP, s.Port); err != nil {
				showError(err)
				return
			}
			refreshServerList()
		}, myWin)
}

// ─── Actions ──────────────────────────────────────────────────────────────────

func doLogout(s Server) {
	k := skey(s.IP, s.Port)
	st.mu.Lock()
	delete(st.tokens, k)
	delete(st.usernames, k)
	delete(st.enrolled, k)
	st.mu.Unlock()
	refreshServerList()
}

func doEnroll(s Server) {
	k := skey(s.IP, s.Port)
	st.mu.RLock()
	token := st.tokens[k]
	username := st.usernames[k]
	st.mu.RUnlock()

	if token == "" {
		showError(fmt.Errorf("not logged in"))
		return
	}

	prog := dialog.NewCustomWithoutButtons("Enrolling device…", widget.NewProgressBarInfinite(), myWin)
	prog.Show()
	go func() {
		_, pubKey, err := ensureClientKeypair()
		if err != nil {
			prog.Hide()
			showError(fmt.Errorf("keypair: %w", err))
			return
		}
		err = apiEnroll(s.IP, s.Port, token, username, st.deviceName, st.machineID, pubKey)
		prog.Hide()
		if err != nil {
			showError(fmt.Errorf("enroll: %w", err))
			return
		}
		dialog.ShowInformation("Enrollment Submitted",
			"Enrollment request sent.\nWait for admin approval before connecting.", myWin)
		refreshServerList()
	}()
}

func doConnect(s Server) {
	k := skey(s.IP, s.Port)
	st.mu.RLock()
	token := st.tokens[k]
	username := st.usernames[k]
	st.mu.RUnlock()

	if token == "" {
		showError(fmt.Errorf("not logged in"))
		return
	}

	// Ensure we have a keypair
	if _, err := os.ReadFile(wgPrivKeyPath); err != nil {
		if _, _, err2 := ensureClientKeypair(); err2 != nil {
			showError(fmt.Errorf("keypair: %w", err2))
			return
		}
	}

	prog := dialog.NewCustomWithoutButtons("Connecting VPN…", widget.NewProgressBarInfinite(), myWin)
	prog.Show()
	go func() {
		// 1. Check enrollment
		enrolled, err := apiCheckEnroll(s.IP, s.Port, token, username, st.deviceName)
		if err != nil || !enrolled {
			prog.Hide()
			showError(fmt.Errorf("device not enrolled or check failed"))
			return
		}

		// 2. Connect – get server config
		cfg, err := apiConnect(s.IP, s.Port, token, username, st.deviceName)
		if err != nil {
			prog.Hide()
			showError(fmt.Errorf("connect: %w", err))
			return
		}

		// 3. Configure local WireGuard interface
		endpoint := cfg.ServerEndpoint
		if endpoint == "" {
			endpoint = fmt.Sprintf("%s:51820", s.IP)
		}
		if err := configureClientInterface(cfg.AllowedIPs, cfg.ServerPublicKey, endpoint, cfg.ServerAllowedIPs); err != nil {
			prog.Hide()
			showError(fmt.Errorf("wg config: %w", err))
			return
		}

		// 4. Save server public key
		_ = updateServerPublicKey(s.IP, s.Port, cfg.ServerPublicKey)

		// 5. Update state
		st.mu.Lock()
		st.connected[k] = true
		st.hbCount = 0
		st.hbFailed = false
		st.hbReason = ""
		st.mu.Unlock()

		prog.Hide()

		// 6. Start heartbeat goroutine
		st.heartbeat.Start(
			s.IP, s.Port, token, st.deviceName, st.machineID,
			func(count int, lastSent time.Time) {
				st.mu.Lock()
				st.hbCount = count
				st.hbLastAt = lastSent
				st.mu.Unlock()
				refreshServerList()
			},
			func(reason string) {
				// Server rejected heartbeat → force disconnect
				st.mu.Lock()
				st.connected[k] = false
				st.hbFailed = true
				st.hbReason = reason
				st.mu.Unlock()
				bringDownVPN()
				refreshServerList()
				showError(fmt.Errorf("VPN disconnected by server:\n%s", reason))
			},
		)

		refreshServerList()
	}()
}

func doDisconnect(s Server) {
	k := skey(s.IP, s.Port)
	st.mu.RLock()
	token := st.tokens[k]
	st.mu.RUnlock()

	// Stop heartbeat first
	st.heartbeat.Stop()

	prog := dialog.NewCustomWithoutButtons("Disconnecting…", widget.NewProgressBarInfinite(), myWin)
	prog.Show()
	go func() {
		// Notify server
		if token != "" {
			_ = apiDisconnect(s.IP, s.Port, token, st.deviceName)
		}
		// Bring down local interface
		bringDownVPN()

		st.mu.Lock()
		st.connected[k] = false
		st.hbCount = 0
		st.hbFailed = false
		st.hbReason = ""
		st.mu.Unlock()

		prog.Hide()
		refreshServerList()
	}()
}

// ─── Connection Status ────────────────────────────────────────────────────────

func refreshConnectionStatus() {
	servers, err := loadServers()
	if err != nil {
		return
	}
	statusMap := getConnectionStatusMap(servers)

	st.mu.Lock()
	for k, v := range statusMap {
		st.connected[k] = v
	}
	// Mark servers not in statusMap as disconnected
	for _, s := range servers {
		k := skey(s.IP, s.Port)
		if _, ok := statusMap[k]; !ok {
			st.connected[k] = false
		}
	}
	st.mu.Unlock()

	refreshServerList()
}

// ─── Heartbeat Status Bar ─────────────────────────────────────────────────────

func updateHeartbeatLabel() {
	if hbLabel == nil {
		return
	}
	st.mu.RLock()
	// Find connected server key
	anyConnected := false
	for _, v := range st.connected {
		if v {
			anyConnected = true
			break
		}
	}
	count := st.hbCount
	lastAt := st.hbLastAt
	failed := st.hbFailed
	reason := st.hbReason
	st.mu.RUnlock()

	if !anyConnected {
		hbLabel.SetText("💤  No active VPN connection")
		return
	}
	if failed {
		hbLabel.SetText(fmt.Sprintf("💀  Heartbeat FAILED — %s", reason))
		return
	}
	if count == 0 {
		hbLabel.SetText("💓  Heartbeat: waiting for first tick (60s)…")
		return
	}
	hbLabel.SetText(fmt.Sprintf("💓  Heartbeat: #%d  last sent at %s  (every 60s)", count, lastAt.Format("15:04:05")))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func showError(err error) {
	dialog.ShowError(err, myWin)
}
