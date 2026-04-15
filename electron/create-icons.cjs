// Script to generate tray icon from SVG
// Run: node electron/create-icons.cjs
// Requires: npm install sharp (optional, for production icons)

const fs = require('fs');
const path = require('path');

// Create a simple 256x256 ICO-compatible PNG for the tray
// This is a base64-encoded 16x16 PNG of a play button icon
const trayIconBase64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA3ElEQVR42mNkoBAwUqifAYtYBxD/B+L/QPwfiP8B8V8g/gPEv4H4FxD/BOIfQPwdiL8B8Vcg/gLEn4H4ExB/BOIPQPweiN8B8Vsg1mZkYPj/H8p+A9V8G6r5FlTzTajmG1DN16Gar0E1X4VqvgLVfBmq+RJU80Wo5gtQzeehms9BNZ+Faj4D1Xwaqvk0VPMpqOaTUM0noJqPQzUfg2o+CtV8BKr5MFTzIajmg1DNB6Ca90M174NqJhkANf+Far4D1UwyIJsBqPkfVDPJAKj5P6nm/wBpnFKBmBIAAMptf/EUMlkwAAAAAElFTkSuQmCC';

const iconPath = path.join(__dirname, 'tray-icon.png');
fs.writeFileSync(iconPath, Buffer.from(trayIconBase64, 'base64'));
console.log('Tray icon created at:', iconPath);
