function parsePolicy(raw) {
  if (raw == null || raw === '') return null;
  const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const methods = Array.isArray(p.allowed_methods) && p.allowed_methods.length
    ? p.allowed_methods.map((m) => String(m).toUpperCase())
    : ['GET', 'HEAD', 'POST'];
  return {
    print: p.print !== false,
    clipboard: p.clipboard !== false,
    download: p.download !== false,
    allowed_methods: methods,
    deny_extensions: Array.isArray(p.deny_extensions)
      ? p.deny_extensions
      : ['.pdf', '.zip', '.doc', '.docx', '.xls', '.xlsx']
  };
}

function buildInjectScript(policy) {
  if (!policy) return '';
  if (policy.print && policy.clipboard && policy.download) return '';
  const payload = {
    print: policy.print,
    clipboard: policy.clipboard,
    download: policy.download,
    denyExt: policy.deny_extensions
  };
  return `<script>(function(){var p=${JSON.stringify(payload)};`
    + 'if(!p.print){var s=document.createElement("style");s.textContent="@media print{body{display:none!important}}";'
    + 'document.documentElement.appendChild(s);window.print=function(){};addEventListener("beforeprint",function(e){e.preventDefault()},true);}'
    + 'if(!p.clipboard){["copy","cut","paste"].forEach(function(ev){document.addEventListener(ev,function(e){e.preventDefault()},true);});'
    + 'if(navigator.clipboard){navigator.clipboard.writeText=function(){return Promise.reject(new Error("disabled"))};'
    + 'navigator.clipboard.readText=function(){return Promise.reject(new Error("disabled"))};}}'
    + 'if(!p.download){document.addEventListener("click",function(e){var a=e.target.closest("a");if(!a)return;'
    + 'var href=(a.getAttribute("href")||"").toLowerCase();'
    + 'if(a.hasAttribute("download")||p.denyExt.some(function(x){return href.endsWith(x)})){e.preventDefault();e.stopPropagation();}},true);}'
    + '})();</script>';
}

module.exports = { parsePolicy, buildInjectScript };
