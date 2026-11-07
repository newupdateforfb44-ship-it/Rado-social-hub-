/* Places files uploaded with flat names into their real folders before the server starts.
   public__rado__sms.html -> public/rado/sms.html     public__js__x.js -> public/js/x.js
   public__style.css      -> public/style.css         lib__mailer.js   -> lib/mailer.js
   Only top-level files whose name starts with "public__" or "lib__" are touched. */
const fs = require('fs');
const path = require('path');
const root = __dirname;
let moved = 0;
for (const name of fs.readdirSync(root)) {
  const m = /^(public|lib)__(.+)$/.exec(name);
  if (!m) continue;
  const src = path.join(root, name);
  if (!fs.statSync(src).isFile()) continue;
  const parts = [m[1]].concat(m[2].split('__'));
  if (parts.some(p => !p || p === '.' || p === '..' || /[\\/]/.test(p))) continue;
  const dest = path.join(root, ...parts);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = fs.readFileSync(src);
    if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(data)) {
      fs.writeFileSync(dest, data);
      moved++;
      console.log('[unflatten] ' + name + ' -> ' + parts.join('/'));
    }
  } catch (e) { console.warn('[unflatten] could not place ' + name + ': ' + e.message); }
}
if (!moved) console.log('[unflatten] nothing to place');
