'use strict'
/**
 * Richtet einen lokalen Minecraft-1.21.1-Server für den KI-Streamer ein:
 *   node scripts/setup-mc-server.js
 * - lädt die offizielle server.jar von Mojang
 * - schreibt server.properties (Offline-Modus, damit der Bot ohne zweiten Account beitreten kann)
 * - trägt Bot und deinen Spielernamen als OP + Whitelist ein
 * Voraussetzung: Java 21. Die Minecraft-EULA musst du selbst bestätigen.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')

const VERSION = '1.21.1'
const DIR = path.join(__dirname, '..', 'mc-server')
const ask = q => new Promise(resolve => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); resolve(a.trim()) }) })

function offlineUuid (name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest()
  h[6] = (h[6] & 0x0f) | 0x30
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

async function main () {
  let botName = 'KI_Streamer'
  try { botName = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.local.json'), 'utf8')).minecraft.username || botName } catch (_) {}
  console.log(`\nMinecraft-Server ${VERSION} für den KI-Streamer einrichten\n`)
  const eula = await ask('Stimmst du der Minecraft-EULA zu (https://aka.ms/MinecraftEULA)? [j/N] ')
  if (!/^(j|ja|y|yes)$/i.test(eula)) { console.log('Abgebrochen – ohne EULA startet der Server nicht.'); process.exit(1) }
  const me = await ask('Dein Minecraft-Name (zum Zuschauen/Aufnehmen, wird OP): ')
  fs.mkdirSync(DIR, { recursive: true })

  const jar = path.join(DIR, 'server.jar')
  if (!fs.existsSync(jar)) {
    console.log('Lade Versionsliste …')
    const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json()
    const entry = manifest.versions.find(v => v.id === VERSION)
    if (!entry) throw new Error('Version nicht gefunden: ' + VERSION)
    const meta = await (await fetch(entry.url)).json()
    const dl = meta.downloads.server
    console.log(`Lade server.jar (${Math.round(dl.size / 1e6)} MB) …`)
    const buf = Buffer.from(await (await fetch(dl.url)).arrayBuffer())
    const sha = crypto.createHash('sha1').update(buf).digest('hex')
    if (sha !== dl.sha1) throw new Error('Prüfsumme der server.jar stimmt nicht')
    fs.writeFileSync(jar, buf)
  }
  fs.writeFileSync(path.join(DIR, 'eula.txt'), 'eula=true\n')
  const propsFile = path.join(DIR, 'server.properties')
  if (!fs.existsSync(propsFile)) {
    fs.writeFileSync(propsFile, [
      'online-mode=false', 'white-list=true', 'enforce-whitelist=true', 'gamemode=survival', 'difficulty=normal', 'spawn-protection=0',
      'server-port=25565', 'view-distance=10', 'simulation-distance=8', 'max-players=5', 'enable-command-block=false', 'pvp=true',
      'motd=KI-Streamer Survival', 'player-idle-timeout=0'
    ].join('\n') + '\n')
  }
  const names = [botName, ...(me ? [me] : [])]
  fs.writeFileSync(path.join(DIR, 'ops.json'), JSON.stringify(names.map(n => ({ uuid: offlineUuid(n), name: n, level: 4, bypassesPlayerLimit: true })), null, 2))
  fs.writeFileSync(path.join(DIR, 'whitelist.json'), JSON.stringify(names.map(n => ({ uuid: offlineUuid(n), name: n })), null, 2))
  console.log(`\nFertig. Server liegt in ${DIR}`)
  console.log('Starten:  MC-SERVER-STARTEN.bat  (oder: cd mc-server && java -Xmx4G -jar server.jar nogui)')
  console.log(`Der Bot "${botName}" ist OP (nötig für Gift-Mobs). Du verbindest dich in Minecraft mit "localhost".`)
  console.log('Hinweis: Offline-Modus + Whitelist. Den Port 25565 nicht ins Internet freigeben.\n')
}
main().catch(e => { console.error('Fehler:', e.message); process.exit(1) })
