import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const { QQ_INSTALL_DIR: root, QQ_DATA_DIR: data, QQ_NODE: node, QQ_SERVICE: service } = process.env;
if (![root, data, node, service].every(Boolean)) throw new Error('Missing deployment environment');
const quote = (v) => JSON.stringify(v);
const dir = path.join(os.homedir(), '.config/systemd/user');
fs.mkdirSync(dir, { recursive: true });
const unit = `[Unit]
Description=QQ Agent Linux (isolated stateless instance)
After=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${root}
Environment=${quote(`QQ_AGENT_DATA_DIR=${data}`)}
Environment=NODE_ENV=production
ExecStart=${quote(node)} ${quote(path.join(root, 'src/server.js'))}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=control-group
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
fs.writeFileSync(path.join(dir, `${service}.service`), unit, { mode: 0o600 });
fs.writeFileSync(path.join(root, '.deployment.json'), JSON.stringify({ root, data, node, service }), { mode: 0o600 });
console.log(`Installed ${service}.service`);
