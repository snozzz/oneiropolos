const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('oneiropolos', {
  postMessage(message) {
    if (message.type === 'pickFolder') ipcRenderer.invoke('oneiropolos:folder', message.start).then((value) => {
      window.postMessage({ source: 'oneiropolos-native', id: message.id, value }, window.location.origin);
    });
    else if (message.type === 'theme') ipcRenderer.send('oneiropolos:theme', message.value);
    else if (message.type === 'language') ipcRenderer.send('oneiropolos:language', message.value);
  },
});
