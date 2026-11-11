'use strict'
/**
 * gift-engine.js – TikTok-Gifts -> echte, native Minecraft-1.21.1-Entities und Support-Drops.
 *
 * - Katalog mit 50 vorinstallierten Gifts + eigene Gifts (Custom Gift Builder) + Live-Auto-Discovery
 * - Nur /summon echter Mobs (NoAI:0b), Untote mit Helm, natives Namensschild
 *   CustomName:'{"text":"⚡ @User","color":"red","bold":true}', CustomNameVisible:1b
 * - Jeder Befehl < 256 Zeichen (Chat-Limit): summon mit Tag, danach gezielte Folgebefehle
 * - Kein eigener Timer: Bossbars werden über tick() aus dem zentralen Game-Loop gepflegt
 */
const { buildDefaultRules, tierAction } = require('./gifts-catalog')

const ACTIONS = {
  zombie_fast: { label: 'Schneller Zombie', kind: 'mob', mob: 'zombie', tier: 1, spawnText: 'einen Zombie' },
  skeleton_armored: { label: 'Gepanzerter Skelett-Schütze', kind: 'mob', mob: 'skeleton', tier: 2, spawnText: 'einen gepanzerten Skelett-Schützen' },
  spawn_mob: { label: 'Mob spawnen (frei wählbar)', kind: 'mob', mob: 'zombie', tier: 2, spawnText: 'Monster' },
  tnt_rain: { label: 'TNT-Regen', kind: 'mob', mob: 'tnt', tier: 3, spawnText: 'TNT-Regen' },
  lightning: { label: 'Blitzeinschlag', kind: 'mob', mob: 'lightning', tier: 3, spawnText: 'einen Blitzeinschlag' },
  creeper_duo: { label: 'Creeper-Duo', kind: 'mob', mob: 'creeper', tier: 3, spawnText: 'ein Creeper-Duo' },
  baby_squad: { label: '5x Baby-Zombie-Blitz-Squad', kind: 'mob', mob: 'zombie', tier: 4, spawnText: 'ein Baby-Zombie-Squad' },
  witch_jockey: { label: 'Hexe + Spinnenreiter', kind: 'mob', mob: 'witch', tier: 4, spawnText: 'eine Hexe mit Spinnenreiter' },
  hit_squad_vindicator: { label: '10x Elite-Diener', kind: 'mob', mob: 'vindicator', tier: 4, spawnText: 'ein Hit-Squad aus Dienern' },
  hit_squad_brute: { label: '10x Piglin-Barbaren', kind: 'mob', mob: 'piglin_brute', tier: 4, spawnText: 'gepanzerte Piglin-Barbaren' },
  boss_ravager: { label: 'Boss: Riesen-Verwüster', kind: 'mob', mob: 'ravager', tier: 5, spawnText: 'der Riesen-Verwüster' },
  boss_warden: { label: 'Boss: Wärter', kind: 'mob', mob: 'warden', tier: 5, spawnText: 'der Wärter' },
  boss_wither_skeleton: { label: 'Boss: Witherskelett-König', kind: 'mob', mob: 'wither_skeleton', tier: 5, spawnText: 'der Witherskelett-König' },
  heal: { label: 'Heilung', kind: 'support', tier: 1, spawnText: 'eine Heilung' },
  speed: { label: 'Speed II', kind: 'support', tier: 1, spawnText: 'Speed zwei' },
  support_apple: { label: 'Goldapfel', kind: 'support', tier: 1, spawnText: 'einen Goldapfel' },
  support_golem: { label: 'Eisengolem-Bodyguard', kind: 'support', mob: 'iron_golem', tier: 1, spawnText: 'einen Eisengolem' },
  support_random: { label: 'Support-Drop (Zufall)', kind: 'support', tier: 1, spawnText: 'einen Support-Drop' },
  drop_food: { label: 'Essen droppen', kind: 'support', tier: 1, spawnText: 'Steaks', gear: 'Essen' },
  drop_weapon: { label: 'Waffe droppen (Eisenschwert)', kind: 'support', tier: 2, spawnText: 'ein Eisenschwert', gear: 'eine starke Waffe' },
  drop_armor: { label: 'Rüstung droppen (Eisen)', kind: 'support', tier: 2, spawnText: 'eine Eisenrüstung', gear: 'eine Rüstung' },
  drop_bed: { label: 'Bett droppen', kind: 'support', tier: 1, spawnText: 'ein Bett', gear: 'ein Bett' },
  drop_diamond_gear: { label: 'Diamant-Ausrüstung droppen', kind: 'support', tier: 3, spawnText: 'Diamant-Ausrüstung', gear: 'Diamant-Ausrüstung' },
  none: { label: 'Nichts', kind: 'none', tier: 0, spawnText: '' }
}

// frei wählbare Mobs für "spawn_mob": Name -> [Basis-HP, deutscher Text, Waffe, Helm]
const MOBS = {
  zombie: [20, 'Zombies', null, 'iron_helmet'], husk: [20, 'Wüstenzombies', null, null], drowned: [20, 'Ertrunkene', 'trident', 'iron_helmet'], skeleton: [20, 'Skelette', 'bow', 'iron_helmet'], stray: [20, 'Eiswanderer', 'bow', 'iron_helmet'],
  spider: [16, 'Spinnen', null, null], cave_spider: [12, 'Höhlenspinnen', null, null], creeper: [20, 'Creeper', null, null], witch: [26, 'Hexen', null, null], enderman: [40, 'Endermen', null, null],
  phantom: [20, 'Phantome', null, null], blaze: [20, 'Lohen', null, null], vindicator: [24, 'Diener', 'iron_axe', null], pillager: [24, 'Plünderer', 'crossbow', null], piglin_brute: [50, 'Piglin-Barbaren', 'golden_axe', null],
  wither_skeleton: [20, 'Witherskelette', 'stone_sword', null], ravager: [100, 'Verwüster', null, null], warden: [500, 'Wärter', null, null], slime: [16, 'Schleime', null, null], silverfish: [8, 'Silberfischchen', null, null]
}

const cleanName = n => String(n || 'Zuschauer').replace(/[^\p{L}\p{N}_.\-]/gu, '').slice(0, 20) || 'Zuschauer'
const r1 = n => Math.round(n * 10) / 10
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 36) || 'gift'

class GiftEngine {
  /**
   * @param {{ runCommands: (cmds: string[]) => boolean, spawnPoint: () => {x:number,y:number,z:number}|null, botPos: () => {x:number,y:number,z:number}|null, onChange?: () => void }} deps
   */
  constructor (deps, rules) {
    this.deps = deps
    this.rules = this.sanitizeRules(rules && rules.length ? rules : buildDefaultRules())
    this.seq = 0
    this.bosses = new Map() // tag -> { bar, started }
    // TikTok-Bibliothek: alle bekannten echten Gifts (Name, Coins, Bild). Start = eingebauter Katalog,
    // sobald ein Live verbunden ist, kommen die echte Gift-Liste des Raums und die Originalbilder dazu.
    this.library = new Map()
    this.libraryAt = 0
    for (const r of buildDefaultRules()) this.library.set(r.giftName.toLowerCase(), { key: r.giftName.toLowerCase(), name: r.giftName, coins: r.coins, emoji: r.emoji, icon: null, alt: r.match, live: false })
  }

  /** Gespeicherte Bibliothek (config/tiktok-gifts.json) wieder einlesen. */
  loadLibrary (saved) {
    if (!saved || !Array.isArray(saved.gifts)) return
    this.learnLibrary(saved.gifts, false)
    this.libraryAt = Number(saved.at) || 0
  }

  /**
   * Echte Gift-Liste von TikTok übernehmen: neue Gifts landen in der Bibliothek, bekannte bekommen
   * Originalbild und aktuellen Coin-Preis. Regeln mit passendem Namen werden mit aktualisiert.
   * @param {{id?: string, name: string, coins?: number, icon?: string}[]} list
   * @returns {boolean} true, wenn sich etwas geändert hat
   */
  learnLibrary (list, stamp = true) {
    let changed = false
    const url = u => (typeof u === 'string' && /^https:\/\//.test(u) && u.length <= 400 ? u : null)
    for (const g of Array.isArray(list) ? list : []) {
      const name = String((g && g.name) || '').trim().slice(0, 40)
      if (!name) continue
      const key = name.toLowerCase()
      const coins = Math.max(0, Math.min(100000, Math.round(Number(g.coins) || 0)))
      const icon = url(g.icon)
      // bekannter Katalog-Eintrag unter englischem Namen (z. B. "Finger Heart" -> "Fingerherz")
      let e = this.library.get(key) || [...this.library.values()].find(x => !x.live && x.alt && x.alt.includes(key))
      if (!e) { e = { key, name, coins: coins || 1, emoji: '🎁', icon: null, alt: [key], live: true }; this.library.set(key, e); changed = true }
      if (icon && e.icon !== icon) { e.icon = icon; changed = true }
      if (coins && e.coins !== coins) { e.coins = coins; changed = true }
      if (g.id != null && e.giftId !== String(g.id)) { e.giftId = String(g.id); changed = true }
      for (const r of this.rules) {
        if (!r.match.includes(key) && !r.match.includes(e.key)) continue
        if (icon && r.icon !== icon) { r.icon = icon; changed = true }
        if (coins && !r.custom && r.coins !== coins) { r.coins = coins; changed = true }
      }
      if (this.library.size >= 1500) break
    }
    if (changed && stamp) this.libraryAt = Date.now()
    return changed
  }

  /** Bibliothek fürs Dashboard, nach Coins sortiert. `ruleId` zeigt, ob das Gift schon eine Regel hat. */
  libraryList () {
    return [...this.library.values()].sort((a, b) => a.coins - b.coins || a.name.localeCompare(b.name)).map(e => {
      const rule = this.rules.find(r => r.match.includes(e.key) || (e.alt || []).some(a => r.match.includes(a)))
      return { key: e.key, name: e.name, coins: e.coins, emoji: e.emoji, icon: e.icon, ruleId: rule ? rule.id : null }
    })
  }

  librarySnapshot () { return { at: this.libraryAt, gifts: [...this.library.values()].filter(e => e.live || e.icon).map(e => ({ id: e.giftId, name: e.name, coins: e.coins, icon: e.icon })) } }

  /** Gift aus der Bibliothek als Regel anlegen (Aktion passend zum Coin-Wert, im Overlay sichtbar). */
  addFromLibrary (key) {
    const e = this.library.get(String(key || '').toLowerCase())
    if (!e) return null
    const have = this.rules.find(r => r.match.includes(e.key))
    if (have) { have.enabled = true; return have }
    const t = tierAction(e.coins || 1)
    const rule = this.sanitizeRule({ id: 'tt_' + slug(e.name), giftName: e.name, match: e.alt, coins: e.coins, emoji: e.emoji, icon: e.icon, action: t.action, amount: t.amount, legend: t.legend, enabled: true, inLegend: true })
    this.rules.push(rule)
    return rule
  }

  sanitizeRule (r) {
    if (!r || !(r.id || r.giftName)) return null
    const act = ACTIONS[r.action] ? r.action : 'none'
    const name = String(r.giftName || r.id).slice(0, 40)
    const match = new Set((Array.isArray(r.match) ? r.match : []).map(m => String(m).toLowerCase().slice(0, 40)).filter(Boolean))
    match.add(name.toLowerCase())
    const icon = typeof r.icon === 'string' && /^https?:\/\//.test(r.icon) ? r.icon.slice(0, 400) : null
    return {
      id: String(r.id || slug(name)).slice(0, 40),
      giftName: name,
      match: [...match].slice(0, 8),
      coins: Math.max(0, Math.min(100000, Number(r.coins) || 0)),
      emoji: String(r.emoji || '🎁').slice(0, 8),
      icon,
      action: act,
      mob: MOBS[r.mob] ? r.mob : null,
      amount: Math.max(1, Math.min(20, Math.round(Number(r.amount) || 1))),
      hpMult: Math.max(0.5, Math.min(10, Number(r.hpMult) || 1)),
      legend: String(r.legend || ACTIONS[act].label).slice(0, 40),
      enabled: r.enabled !== false,
      inLegend: !!r.inLegend,
      custom: !!r.custom,
      discovered: !!r.discovered
    }
  }

  sanitizeRules (rules) {
    const out = []
    const seen = new Set()
    for (const raw of Array.isArray(rules) ? rules : []) {
      const r = this.sanitizeRule(raw)
      if (!r || seen.has(r.id)) continue
      seen.add(r.id)
      out.push(r)
      if (out.length >= 200) break
    }
    return out
  }

  setRules (rules) { this.rules = this.sanitizeRules(rules); return this.rules }
  resetRules () { this.rules = this.sanitizeRules(buildDefaultRules()); return this.rules }

  /** Eigenes Gift anlegen oder ein bestehendes ändern (Custom Gift Builder). */
  upsertRule (raw) {
    const r = this.sanitizeRule({ ...raw, id: raw.id || 'custom_' + slug(raw.giftName), custom: raw.custom !== false })
    if (!r) return null
    const i = this.rules.findIndex(x => x.id === r.id)
    if (i >= 0) this.rules[i] = { ...this.rules[i], ...r, match: [...new Set([...this.rules[i].match, ...r.match])].slice(0, 8) }
    else this.rules.push(r)
    return i >= 0 ? this.rules[i] : r
  }

  removeRule (id) { const n = this.rules.length; this.rules = this.rules.filter(r => r.id !== id); return this.rules.length < n }

  /** Icon-URLs, die TikTok live liefert, in den Katalog übernehmen. */
  learnIcons (icons) {
    let changed = false
    for (const r of this.rules) {
      if (r.icon) continue
      for (const m of r.match) if (icons[m]) { r.icon = icons[m]; changed = true; break }
    }
    return changed
  }

  /** Öffentliche Sicht für die Overlay-Legende (GIFT_CONFIG_SYNC). */
  publicConfig () {
    const act = r => ACTIONS[r.action]
    let list = this.rules.filter(r => r.enabled && r.action !== 'none' && r.inLegend)
    if (!list.length) list = this.rules.filter(r => r.enabled && r.action !== 'none').slice(0, 8)
    return list.sort((a, b) => a.coins - b.coins).slice(0, 24).map(r => ({
      id: r.id, name: r.giftName, coins: r.coins, emoji: r.emoji, legend: r.legend, kind: act(r).kind, tier: act(r).tier, icon: r.icon
    }))
  }

  /** Günstigstes aktives Support-Gift einer Art – für die taktischen Hilferufe des Streamers. */
  supportGift (kinds) {
    const c = this.rules.filter(r => r.enabled && kinds.includes(r.action)).sort((a, b) => a.coins - b.coins)[0]
    return c ? { name: c.giftName, coins: c.coins, gear: ACTIONS[c.action].gear || ACTIONS[c.action].spawnText } : null
  }

  findRule (gift) {
    const name = String(gift.name || '').toLowerCase().trim()
    return this.rules.find(r => r.id === gift.ruleId) || this.rules.find(r => r.match.includes(name)) || null
  }

  /** Live-Auto-Discovery: unbekanntes Gift in den Katalog aufnehmen, Aktion passend zum Coin-Wert. */
  discover (gift) {
    const t = tierAction(gift.coins || 1)
    const rule = this.sanitizeRule({ id: 'live_' + slug(gift.name || gift.id), giftName: gift.name || `Gift ${gift.id}`, coins: gift.coins || 1, emoji: '🎁', icon: gift.icon, action: t.action, amount: t.amount, legend: t.legend, enabled: true, discovered: true })
    this.rules.push(rule)
    if (this.deps.onChange) this.deps.onChange('discovered', rule)
    return rule
  }

  nameTag (user, prefix = '⚡', color = 'red') {
    return `{CustomName:'{"text":"${prefix} @${cleanName(user)}","color":"${color}","bold":true}',CustomNameVisible:1b}`
  }

  /**
   * Baut die Befehlsliste für eine Regel. Rein funktional -> testbar ohne Server.
   * @returns {{cmds: string[], effect: object, tag: string}}
   */
  build (rule, user, count = 1, at = null, botPos = null) {
    if (typeof rule === 'string') rule = { action: rule, amount: 1, hpMult: 1, mob: null }
    let actionId = ACTIONS[rule.action] ? rule.action : 'none'
    if (actionId === 'support_random') actionId = ['support_apple', 'speed', 'heal', 'support_golem'][Math.floor(Math.random() * 4)]
    const act = ACTIONS[actionId]
    const tag = `g${++this.seq}`
    const sel = `@e[tag=${tag}]`
    const p = at || { x: 0, y: 64, z: 0 }
    const X = (dx = 0) => r1(p.x + dx)
    const Z = (dz = 0) => r1(p.z + dz)
    const spread = (k = 1) => (Math.random() - 0.5) * 3 * k
    const cmds = []
    const tags = `NoAI:0b,Tags:["giftmob","${tag}"],PersistenceRequired:1b`
    const name = (prefix, color) => cmds.push(`execute as ${sel} run data merge entity @s ${this.nameTag(user, prefix, color)}`)
    const amount = rule.amount || 1
    const n = Math.max(1, Math.min(20, amount * Math.max(1, Math.min(8, count))))
    const hpMult = rule.hpMult || 1
    const scaleHp = (base) => {
      if (hpMult === 1) return
      const hp = Math.round(base * hpMult)
      cmds.push(`execute as ${sel} run attribute @s minecraft:generic.max_health base set ${hp}`)
      cmds.push(`execute as ${sel} run data merge entity @s {Health:${hp}f}`)
    }
    const summonN = (mob, k, extra = '', wide = 1) => { for (let i = 0; i < k; i++) cmds.push(`summon ${mob} ${X(i ? spread(wide) : 0)} ${p.y} ${Z(i ? spread(wide) : 0)} {${extra}${tags}}`) }
    let mobName = act.mob
    let spawnText = act.spawnText

    switch (actionId) {
      case 'zombie_fast':
        summonN('zombie', n)
        cmds.push(`item replace entity ${sel} armor.head with iron_helmet`)
        cmds.push(`execute as ${sel} run attribute @s minecraft:generic.movement_speed base set 0.31`)
        scaleHp(20); name('⚡', 'red')
        if (n > 1) spawnText = `${n} Zombies`
        break
      case 'skeleton_armored':
        summonN('skeleton', Math.min(n, 6))
        cmds.push(`item replace entity ${sel} weapon.mainhand with bow`)
        cmds.push(`item replace entity ${sel} armor.head with golden_helmet`)
        cmds.push(`item replace entity ${sel} armor.chest with chainmail_chestplate`)
        scaleHp(20); name('🏹', 'red')
        break
      case 'spawn_mob': {
        const mob = MOBS[rule.mob] ? rule.mob : 'zombie'
        const [hp, text, weapon, helmet] = MOBS[mob]
        mobName = mob
        spawnText = n > 1 ? `${n} ${text}` : text
        summonN(mob, Math.min(n, mob === 'warden' || mob === 'ravager' ? 3 : 12), mob === 'piglin_brute' ? 'IsImmuneToZombification:1b,' : '', 1.4)
        if (weapon) cmds.push(`item replace entity ${sel} weapon.mainhand with ${weapon}`)
        if (helmet) cmds.push(`item replace entity ${sel} armor.head with ${helmet}`)
        scaleHp(hp); name('⚡', 'red')
        break
      }
      case 'tnt_rain': {
        const c = botPos || p
        const k = Math.min(12, 3 + n)
        for (let i = 0; i < k; i++) cmds.push(`summon tnt ${r1(c.x + (Math.random() - 0.5) * 9)} ${c.y + 12 + i} ${r1(c.z + (Math.random() - 0.5) * 9)} {fuse:${50 + i * 6},Tags:["giftmob","${tag}"]}`)
        name('💣', 'gold')
        break
      }
      case 'lightning': {
        const c = botPos || p
        for (let i = 0; i < Math.min(6, n); i++) cmds.push(`summon lightning_bolt ${r1(c.x + (Math.random() - 0.5) * 7)} ${c.y} ${r1(c.z + (Math.random() - 0.5) * 7)}`)
        break
      }
      case 'creeper_duo':
        cmds.push(`summon creeper ${X(-1)} ${p.y} ${Z()} {${tags}}`)
        cmds.push(`summon creeper ${X(1)} ${p.y} ${Z()} {${tags}}`)
        scaleHp(20); name('💥', 'green')
        break
      case 'baby_squad':
        summonN('zombie', 5, 'IsBaby:1b,')
        cmds.push(`item replace entity ${sel} armor.head with golden_helmet`)
        scaleHp(20); name('⚡', 'red')
        break
      case 'witch_jockey':
        cmds.push(`summon witch ${X(-1.5)} ${p.y} ${Z()} {${tags}}`)
        cmds.push(`summon spider ${X(1.5)} ${p.y} ${Z()} {${tags},Passengers:[{id:"minecraft:skeleton",Tags:["giftmob","${tag}","${tag}r"]}]}`)
        cmds.push(`item replace entity @e[tag=${tag}r] weapon.mainhand with bow`)
        cmds.push(`item replace entity @e[tag=${tag}r] armor.head with iron_helmet`)
        name('🧪', 'dark_purple')
        break
      case 'hit_squad_vindicator': {
        const k = amount > 1 ? Math.min(12, amount) : 10
        summonN('vindicator', k, '', 1.6)
        cmds.push(`item replace entity ${sel} weapon.mainhand with iron_axe`)
        cmds.push(`item replace entity ${sel} armor.head with iron_helmet`)
        scaleHp(24); name('🪓', 'dark_red')
        spawnText = `ein Hit-Squad aus ${k} Dienern`
        break
      }
      case 'hit_squad_brute':
        summonN('piglin_brute', 10, 'IsImmuneToZombification:1b,', 1.6)
        cmds.push(`item replace entity ${sel} weapon.mainhand with golden_axe`)
        cmds.push(`item replace entity ${sel} armor.chest with golden_chestplate`)
        scaleHp(50); name('🪓', 'gold')
        break
      case 'boss_ravager':
      case 'boss_warden':
      case 'boss_wither_skeleton': {
        const mob = act.mob
        const hp = Math.round((mob === 'warden' ? 500 : mob === 'ravager' ? 200 : 150) * hpMult)
        const title = { ravager: 'Riesen-Verwüster', warden: 'Wärter', wither_skeleton: 'Witherskelett-König' }[mob]
        summonN(mob, Math.min(3, amount), '', 2)
        if (mob !== 'warden') cmds.push(`execute as ${sel} run attribute @s minecraft:generic.scale base set ${mob === 'ravager' ? 1.5 : 2}`)
        if (mob !== 'warden' || hpMult !== 1) {
          cmds.push(`execute as ${sel} run attribute @s minecraft:generic.max_health base set ${hp}`)
          cmds.push(`execute as ${sel} run data merge entity @s {Health:${hp}f}`)
        }
        if (mob === 'wither_skeleton') {
          cmds.push(`item replace entity ${sel} weapon.mainhand with netherite_sword`)
          cmds.push(`item replace entity ${sel} armor.head with netherite_helmet`)
        }
        name('👑', 'dark_purple')
        const bar = `gm:${tag}`
        cmds.push(`bossbar add ${bar} {"text":"👑 ${title} von @${cleanName(user)}","color":"light_purple","bold":true}`)
        cmds.push(`bossbar set ${bar} color purple`)
        cmds.push(`bossbar set ${bar} max ${hp}`)
        cmds.push(`bossbar set ${bar} value ${hp}`)
        cmds.push(`bossbar set ${bar} players @a`)
        this.bosses.set(tag, { bar, started: Date.now() })
        break
      }
      case 'heal':
        cmds.push('effect give @s minecraft:instant_health 1 1')
        cmds.push('effect give @s minecraft:regeneration 12 1')
        cmds.push('effect give @s minecraft:saturation 2 0')
        break
      case 'speed': cmds.push('effect give @s minecraft:speed 30 1'); break
      case 'support_apple': cmds.push(`give @s golden_apple ${Math.min(n, 4)}`); break
      case 'support_golem':
        cmds.push(`summon iron_golem ${X()} ${p.y} ${Z()} {PlayerCreated:1b,Tags:["giftfriend","${tag}"]}`)
        name('🛡', 'green')
        break
      case 'drop_food': cmds.push(`give @s cooked_beef ${Math.min(32, 8 * n)}`); break
      case 'drop_weapon': cmds.push('give @s iron_sword 1'); break
      case 'drop_armor': for (const part of ['helmet', 'chestplate', 'leggings', 'boots']) cmds.push(`give @s iron_${part} 1`); cmds.push('give @s shield 1'); break
      case 'drop_bed': cmds.push('give @s red_bed 1'); break
      case 'drop_diamond_gear': for (const it of ['diamond_sword', 'diamond_pickaxe', 'diamond_chestplate', 'golden_apple']) cmds.push(`give @s ${it} 1`); break
      default: break
    }
    return { cmds, tag, effect: { ...act, action: actionId, mob: mobName, spawnText, label: rule.legend || act.label } }
  }

  /** Aus dem zentralen Game-Loop: Bossbar folgt der Boss-Gesundheit und verschwindet mit dem Boss. */
  tick () {
    if (!this.bosses.size) return
    const cmds = []
    for (const [tag, b] of this.bosses) {
      if (Date.now() - b.started > 8 * 60000) { cmds.push(`bossbar remove ${b.bar}`); this.bosses.delete(tag); continue }
      cmds.push(`execute store result bossbar ${b.bar} value run data get entity @e[tag=${tag},limit=1] Health`)
      cmds.push(`execute unless entity @e[tag=${tag}] run bossbar remove ${b.bar}`)
    }
    if (cmds.length) this.deps.runCommands(cmds)
  }

  /**
   * Gift auslösen. Unbekannte Gifts werden automatisch in den Katalog aufgenommen.
   * @returns {{ok: boolean, rule: object, effect: object, reason?: string, discovered?: boolean}}
   */
  trigger (gift, viewer, count = 1) {
    let rule = this.findRule(gift)
    let discovered = false
    if (!rule) { rule = this.discover(gift); discovered = true }
    if (gift.icon && !rule.icon) { rule.icon = gift.icon; if (this.deps.onChange) this.deps.onChange('icon', rule) }
    if (!rule.enabled || rule.action === 'none') return { ok: false, rule, effect: { ...ACTIONS.none, label: 'deaktiviert' }, reason: 'disabled', discovered }
    const at = this.deps.spawnPoint()
    const built = this.build(rule, viewer.uniqueId || viewer.nickname, count, at, this.deps.botPos())
    const sent = at ? this.deps.runCommands(built.cmds) : false
    return { ok: !!sent, rule, effect: built.effect, reason: sent ? null : 'bot_offline', discovered }
  }
}

module.exports = { GiftEngine, ACTIONS, MOBS, cleanName }
