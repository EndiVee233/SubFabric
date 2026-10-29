'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sourcePath } = require('./security.cjs');
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../build/electron-stage/manifest.json'), 'utf8'));
module.exports = {
  ...JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).build,
  extraResources: [
    {
      from: '../build/electron-stage', to: 'backend',
      filter: ['manifest.json', 'node.exe', ...manifest.files.map(entry => 'payload/' + sourcePath(entry.path))]
    },
    // 托盘图标：与安装包/窗口图标同源，运行时可从 resources\tray.ico 读取。
    { from: '../build/installer/logo.ico', to: 'tray.ico' }
  ]
};
