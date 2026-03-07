import mysql.connector
import time
import subprocess

db_config = {
    "host": "localhost",
    "user": "root",
    "password": "root",
    "database": "wg_monitor"
}

def main():
    conn = mysql.connector.connect(**db_config)
    cursor = conn.cursor(dictionary=True)

    current_time = int(time.time())

    cursor.execute("SELECT username FROM users WHERE expire_day IS NOT NULL AND expire_day < %s", (current_time,))
    expired_users = cursor.fetchall()

    for user in expired_users:
        username = user["username"]

        cursor.execute("SELECT public_key FROM devices WHERE username = %s", (username,))
        devices = cursor.fetchall()

        for device in devices:
            public_key = device["public_key"]

            subprocess.run(
                ["wg", "set", "wg2", "peer", public_key, "remove"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )

        cursor.execute("DELETE FROM devices WHERE username = %s", (username,))
        cursor.execute("DELETE FROM users WHERE username = %s", (username,))

    conn.commit()
    cursor.close()
    conn.close()

if __name__ == "__main__":
    main()