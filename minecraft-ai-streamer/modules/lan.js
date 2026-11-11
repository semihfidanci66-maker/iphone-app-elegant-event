'use strict'
/** lan.js – IPv4-Adressen des PCs im Heimnetz (für die Handy-Fernbedienung im selben WLAN). */
const os = require('os')

const isPrivate = a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)

/** Private Adressen zuerst 192.168.x.x (typisches WLAN), virtuelle Adapter ans Ende. */
function lanAddresses (ifaces = os.networkInterfaces()) {
  const out = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list || []) {
      if (i.internal || (i.family !== 'IPv4' && i.family !== 4) || !isPrivate(i.address)) continue
      const virtual = /vethernet|virtual|vmware|vbox|docker|wsl|hyper-v|tailscale|zerotier|loopback/i.test(name)
      out.push({ address: i.address, rank: (virtual ? 10 : 0) + (i.address.startsWith('192.168.') ? 0 : 1) })
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map(x => x.address)
}

module.exports = { lanAddresses }
