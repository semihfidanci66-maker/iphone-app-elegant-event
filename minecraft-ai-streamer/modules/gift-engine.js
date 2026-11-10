'use strict'
/**
 * gift-engine.js – TikTok-Gifts -> echte, native Minecraft-1.21.1-Entities.
 *
 * - Keine Platzhalter-Blöcke, keine unsichtbaren Rüstungsständer: nur /summon echter Mobs
 * - Untote tragen einen Helm (brennen nie im Tageslicht)
 * - Namensschild: CustomName:'{"text":"⚡ @User","color":"red","bold":true}', CustomNameVisible:1b
 * - Jeder Befehl bleibt unter 256 Zeichen (Chat-Limit): summon mit Tag, danach gezielte Folgebefehle
 */

const ACTIONS = {
  zombie_fast: { label: 'Schneller Zombie', kind: 'mob', mob: 'zombie', tier: 1, spawnText: 'einen Zombie' },
  skeleton_armored: { label: 'Gepanzerter Skelett-Schütze', kind: 'mob', mob: 'skeleton', tier: 2, spawnText: 'einen gepanzerten Skelett-Schützen' },
  tnt_rain: { label: 'TNT-Regen', kind: 'mob', mob: 'tnt', tier: 3, spawnText: 'TNT-Regen' },
  creeper_duo: { label: 'Creeper-Duo', kind: 'mob', mob: 'creeper', tier: 3, spawnText: 'ein Creeper-Duo' },
  baby_squad: { label: '5x Baby-Zombie-Blitz-Squad', kind: 'mob', mob: 'zombie', tier: 4, spawnText: 'ein Baby-Zombie-Squad' },
  witch_jockey: { label: 'Hexe + Spinnenreiter', kind: 'mob', mob: 'witch', tier: 4, spawnText: 'eine Hexe mit Spinnenreiter' },
  hit_squad_vindicator: { label: '10x Elite-Diener', kind: 'mob', mob: 'vindicator', tier: 4, spawnText: 'ein Hit-Squad aus zehn Dienern' },
  hit_squad_brute: { label: '10x Piglin-Barbaren', kind: 'mob', mob: 'piglin_brute', tier: 4, spawnText: 'zehn gepanzerte Piglin-Barbaren' },
  boss_ravager: { label: 'Endboss: Riesen-Verwüster', kind: 'mob', mob: 'ravager', tier: 5, spawnText: 'der Riesen-Verwüster' },
  boss_warden: { label: 'Endboss: Wärter', kind: 'mob', mob: 'warden', tier: 5, spawnText: 'der Wärter' },
  boss_wither_skeleton: { label: 'Endboss: Witherskelett-König', kind: 'mob', mob: 'wither_skeleton', tier: 5, spawnText: 'der Witherskelett-König' },
  support_apple: { label: 'Heilung: Goldapfel', kind: 'support', tier: 1, spawnText: 'einen Goldapfel' },
  support_speed: { label: 'Speed II', kind: 'support', tier: 1, spawnText: 'Speed zwei' },
  support_golem: { label: 'Eisengolem-Bodyguard', kind: 'support', mob: 'iron_golem', tier: 1, spawnText: 'einen Eisengolem' },
  support_random: { label: 'Support-Drop (Zufall)', kind: 'support', tier: 1, spawnText: 'einen Support-Drop' },
  none: { label: 'Nichts', kind: 'none', tier: 0, spawnText: '' }
}

const DEFAULT_RULES = [
  { id: 'rose', giftName: 'Rose', match: ['rose'], coins: 1, emoji: '🌹', action: 'zombie_fast', legend: 'Zombie', enabled: true },
  { id: 'ice_cream', giftName: 'Eistüte', match: ['ice cream cone', 'ice cream', 'eistüte', 'eis'], coins: 1, emoji: '🍦', action: 'support_random', legend: 'Heilung', enabled: true },
  { id: 'gg', giftName: 'GG', match: ['gg'], coins: 1, emoji: '🎮', action: 'support_random', legend: 'Support-Drop', enabled: true },
  { id: 'finger_heart', giftName: 'Fingerherz', match: ['finger heart', 'fingerherz'], coins: 5, emoji: '💖', action: 'skeleton_armored', legend: 'Skelett-Schütze', enabled: true },
  { id: 'donut', giftName: 'Donut', match: ['doughnut', 'donut'], coins: 30, emoji: '🍩', action: 'tnt_rain', legend: 'TNT-Regen', enabled: true },
  { id: 'hand_heart', giftName: 'Handherz', match: ['hand hearts', 'hand heart', 'handherz', 'heart me'], coins: 100, emoji: '🫶', action: 'baby_squad', legend: 'Baby-Zombie-Squad', enabled: true },
  { id: 'money_gun', giftName: 'Money Gun', match: ['money gun'], coins: 500, emoji: '💸', action: 'hit_squad_vindicator', legend: 'Hit-Squad x10', enabled: true },
  { id: 'galaxy', giftName: 'Galaxie', match: ['galaxy', 'galaxie'], coins: 1000, emoji: '🌌', action: 'boss_ravager', legend: 'Endboss', enabled: true }
]

const cleanName = n => String(n || 'Zuschauer').replace(/[^\p{L}\p{N}_.\-]/gu, '').slice(0, 20) || 'Zuschauer'
const r1 = n => Math.round(n * 10) / 10

class GiftEngine {
  /**
   * @param {{ runCommands: (cmds: string[]) => boolean, spawnPoint: () => {x:number,y:number,z:number}|null, botPos: () => {x:number,y:number,z:number}|null }} deps
   */
  constructor (deps, rules) {
    this.deps = deps
    this.rules = this.sanitizeRules(rules || DEFAULT_RULES)
    this.seq = 0
    this.bossTimers = new Map()
    this.icons = {} // giftName(lower) -> Bild-URL (kommt live von TikTok)
  }

  sanitizeRules (rules) {
    const out = []
    for (const r of Array.isArray(rules) ? rules : []) {
      if (!r || !r.id) continue
      out.push({
        id: String(r.id).slice(0, 40),
        giftName: String(r.giftName || r.id).slice(0, 40),
        match: (Array.isArray(r.match) ? r.match : [r.giftName || r.id]).map(m => String(m).toLowerCase().slice(0, 40)),
        coins: Math.max(0, Number(r.coins) || 0),
        emoji: String(r.emoji || '🎁').slice(0, 8),
        action: ACTIONS[r.action] ? r.action : 'none',
        legend: String(r.legend || (ACTIONS[r.action] || ACTIONS.none).label).slice(0, 40),
        enabled: r.enabled !== false
      })
    }
    return out
  }

  setRules (rules) { this.rules = this.sanitizeRules(rules); return this.rules }

  /** Öffentliche Sicht für Overlay/Dashboard (GIFT_CONFIG_SYNC). */
  publicConfig () {
    return this.rules.filter(r => r.enabled && r.action !== 'none').sort((a, b) => a.coins - b.coins).map(r => ({
      id: r.id, name: r.giftName, coins: r.coins, emoji: r.emoji, legend: r.legend, kind: ACTIONS[r.action].kind, tier: ACTIONS[r.action].tier, icon: this.iconFor(r)
    }))
  }

  iconFor (rule) {
    for (const m of [rule.giftName.toLowerCase(), ...rule.match]) if (this.icons[m]) return this.icons[m]
    return null
  }

  findRule (gift) {
    const name = String(gift.name || '').toLowerCase().trim()
    let rule = this.rules.find(r => r.enabled && (r.id === gift.ruleId || r.match.includes(name) || r.giftName.toLowerCase() === name))
    if (!rule && gift.coins > 0) {
      // Unbekanntes Gift: die Regel mit dem höchsten Preis <= Wert greift (jedes Gift löst etwas aus)
      const cands = this.rules.filter(r => r.enabled && r.coins <= gift.coins && ACTIONS[r.action].kind === 'mob').sort((a, b) => b.coins - a.coins)
      rule = cands[0] || null
    }
    return rule || null
  }

  nameTag (user, prefix = '⚡', color = 'red') {
    return `{CustomName:'{"text":"${prefix} @${cleanName(user)}","color":"${color}","bold":true}',CustomNameVisible:1b}`
  }

  /**
   * Baut die Befehlsliste für eine Aktion. Rein funktional -> testbar ohne Server.
   * @returns {{cmds: string[], effect: object, tag: string}}
   */
  build (actionId, user, count = 1, at = null, botPos = null) {
    const act = ACTIONS[actionId] || ACTIONS.none
    const tag = `g${++this.seq}`
    const sel = `@e[tag=${tag}]`
    const p = at || { x: 0, y: 64, z: 0 }
    const X = (dx = 0) => r1(p.x + dx)
    const Z = (dz = 0) => r1(p.z + dz)
    const spread = () => (Math.random() - 0.5) * 3
    const cmds = []
    const tags = `Tags:["giftmob","${tag}"],PersistenceRequired:1b`
    const name = (prefix, color) => cmds.push(`execute as ${sel} run data merge entity @s ${this.nameTag(user, prefix, color)}`)
    const n = Math.max(1, Math.min(8, count))

    switch (actionId) {
      case 'zombie_fast':
        for (let i = 0; i < n; i++) cmds.push(`summon zombie ${X(i ? spread() : 0)} ${p.y} ${Z(i ? spread() : 0)} {${tags}}`)
        cmds.push(`item replace entity ${sel} armor.head with iron_helmet`)
        cmds.push(`execute as ${sel} run attribute @s minecraft:generic.movement_speed base set 0.31`)
        name('⚡', 'red')
        break
      case 'skeleton_armored':
        for (let i = 0; i < Math.min(n, 4); i++) cmds.push(`summon skeleton ${X(i ? spread() : 0)} ${p.y} ${Z(i ? spread() : 0)} {${tags}}`)
        cmds.push(`item replace entity ${sel} weapon.mainhand with bow`)
        cmds.push(`item replace entity ${sel} armor.head with golden_helmet`)
        cmds.push(`item replace entity ${sel} armor.chest with chainmail_chestplate`)
        name('🏹', 'red')
        break
      case 'tnt_rain': {
        const c = botPos || p
        for (let i = 0; i < Math.min(8, 4 + n); i++) {
          cmds.push(`summon tnt ${r1(c.x + (Math.random() - 0.5) * 9)} ${c.y + 12 + i} ${r1(c.z + (Math.random() - 0.5) * 9)} {fuse:${50 + i * 6},Tags:["giftmob","${tag}"]}`)
        }
        name('💣', 'gold')
        break
      }
      case 'creeper_duo':
        cmds.push(`summon creeper ${X(-1)} ${p.y} ${Z()} {${tags}}`)
        cmds.push(`summon creeper ${X(1)} ${p.y} ${Z()} {${tags}}`)
        name('💥', 'green')
        break
      case 'baby_squad':
        for (let i = 0; i < 5; i++) cmds.push(`summon zombie ${X(spread())} ${p.y} ${Z(spread())} {IsBaby:1b,${tags}}`)
        cmds.push(`item replace entity ${sel} armor.head with golden_helmet`)
        name('⚡', 'red')
        break
      case 'witch_jockey':
        cmds.push(`summon witch ${X(-1.5)} ${p.y} ${Z()} {${tags}}`)
        cmds.push(`summon spider ${X(1.5)} ${p.y} ${Z()} {${tags},Passengers:[{id:"minecraft:skeleton",Tags:["giftmob","${tag}","${tag}r"]}]}`)
        cmds.push(`item replace entity @e[tag=${tag}r] weapon.mainhand with bow`)
        cmds.push(`item replace entity @e[tag=${tag}r] armor.head with iron_helmet`)
        name('🧪', 'dark_purple')
        break
      case 'hit_squad_vindicator':
        for (let i = 0; i < 10; i++) cmds.push(`summon vindicator ${X(spread() * 1.6)} ${p.y} ${Z(spread() * 1.6)} {${tags}}`)
        cmds.push(`item replace entity ${sel} weapon.mainhand with iron_axe`)
        cmds.push(`item replace entity ${sel} armor.head with iron_helmet`)
        name('🪓', 'dark_red')
        break
      case 'hit_squad_brute':
        for (let i = 0; i < 10; i++) cmds.push(`summon piglin_brute ${X(spread() * 1.6)} ${p.y} ${Z(spread() * 1.6)} {IsImmuneToZombification:1b,${tags}}`)
        cmds.push(`item replace entity ${sel} weapon.mainhand with golden_axe`)
        cmds.push(`item replace entity ${sel} armor.chest with golden_chestplate`)
        name('🪓', 'gold')
        break
      case 'boss_ravager':
      case 'boss_warden':
      case 'boss_wither_skeleton': {
        const mob = act.mob
        const hp = mob === 'warden' ? 500 : mob === 'ravager' ? 200 : 150
        const title = { ravager: 'Riesen-Verwüster', warden: 'Wärter', wither_skeleton: 'Witherskelett-König' }[mob]
        cmds.push(`summon ${mob} ${X()} ${p.y} ${Z()} {${tags}}`)
        if (mob !== 'warden') {
          cmds.push(`execute as ${sel} run attribute @s minecraft:generic.scale base set ${mob === 'ravager' ? 1.5 : 2}`)
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
        this.trackBoss(tag, bar)
        break
      }
      case 'support_apple':
        cmds.push(`give @s golden_apple ${Math.min(n, 3)}`)
        break
      case 'support_speed':
        cmds.push('effect give @s minecraft:speed 30 1')
        break
      case 'support_golem':
        cmds.push(`summon iron_golem ${X()} ${p.y} ${Z()} {PlayerCreated:1b,Tags:["giftfriend","${tag}"]}`)
        name('🛡', 'green')
        break
      default:
        break
    }
    return { cmds, tag, effect: { ...act, action: actionId } }
  }

  /** Bossbar folgt serverseitig der Boss-Gesundheit und verschwindet mit dem Boss. */
  trackBoss (tag, bar) {
    const started = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - started > 8 * 60000) {
        clearInterval(timer); this.bossTimers.delete(tag)
        this.deps.runCommands([`bossbar remove ${bar}`])
        return
      }
      this.deps.runCommands([
        `execute store result bossbar ${bar} value run data get entity @e[tag=${tag},limit=1] Health`,
        `execute unless entity @e[tag=${tag}] run bossbar remove ${bar}`
      ])
    }, 1500)
    this.bossTimers.set(tag, timer)
  }

  dispose () { for (const t of this.bossTimers.values()) clearInterval(t); this.bossTimers.clear() }

  /**
   * Gift auslösen.
   * @returns {{ok: boolean, rule?: object, effect?: object, reason?: string}}
   */
  trigger (gift, viewer, count = 1) {
    const rule = this.findRule(gift)
    if (!rule) return { ok: false, reason: 'no_rule' }
    let actionId = rule.action
    if (actionId === 'support_random') actionId = ['support_apple', 'support_speed', 'support_golem'][Math.floor(Math.random() * 3)]
    if (actionId === 'tnt_rain' && Math.random() < 0.35) actionId = 'creeper_duo'
    const at = this.deps.spawnPoint()
    const built = this.build(actionId, viewer.uniqueId || viewer.nickname, count, at, this.deps.botPos())
    const sent = at ? this.deps.runCommands(built.cmds) : false
    return { ok: !!sent, rule, effect: built.effect, reason: sent ? null : 'bot_offline' }
  }
}

module.exports = { GiftEngine, ACTIONS, DEFAULT_RULES, cleanName }
