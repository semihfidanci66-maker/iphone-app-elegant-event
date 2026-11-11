'use strict'
/**
 * arena-builder.js – baut die TikTok-Live-Arena per Server-Befehl und animiert sie.
 *
 * 41x41 Kampffläche, Mauer mit unsichtbarer Barriere, vier Tribünen-Ränge mit winkenden Zuschauern,
 * Flutlicht-Türme, Smaragd-Maschine und Schmiede hinten rechts, Bestenliste als Hologramm.
 *
 * Alle Befehle sind für Minecraft Java 1.21.1 geschrieben (Gegenstands-Komponenten statt NBT-Tags),
 * bleiben unter 256 Zeichen (Chat-Limit, falls sie über den Bot laufen) und werden in
 * test/commands.js gegen die Befehls-Syntax geprüft. Die Klasse erzeugt nur Befehle – ausgeführt
 * werden sie über die Funktion `run`, die der Aufrufer mitgibt.
 */
const { Vec3 } = require('vec3')

const RADIUS = 20 // 41x41 Kampffläche
const FAN_COLORS = [16711680, 65280, 255, 16776960, 16711935, 65535]
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N}_ .-]/gu, '').trim().slice(0, 20) || 'TikTok-User'

class ArenaBuilder {
  /**
   * @param {{center?: {x:number,y:number,z:number}, run: (cmds: string[]) => boolean, botName: () => string}} o
   */
  constructor (o) {
    this.run = o.run
    this.botName = o.botName
    this.center = o.center ? new Vec3(o.center.x, o.center.y, o.center.z) : null
    this.radius = RADIUS
    this.built = false
    this.animTimer = null
    this.animTick = 0
    this.seq = 0
  }

  setCenter (c) { this.center = new Vec3(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z)) }

  getWaypoints () {
    const { x: cx, y: cy, z: cz } = this.center
    return {
      center: new Vec3(cx + 0.5, cy, cz + 0.5),
      farmStandPos: new Vec3(cx + 15.5, cy, cz + 15.5),
      farmTargetBlock: new Vec3(cx + 17.5, cy + 1.5, cz + 17.5),
      upgradePos: new Vec3(cx + 10.5, cy, cz + 16.5),
      anvilBlock: new Vec3(cx + 10.5, cy + 0.5, cz + 18.5),
      zombieSpawnPoints: [new Vec3(cx + 0.5, cy, cz - 13.5), new Vec3(cx - 13.5, cy, cz + 0.5), new Vec3(cx + 0.5, cy, cz + 12.5), new Vec3(cx - 9.5, cy, cz - 9.5)]
    }
  }

  // ---------------------------------------------------------------- Bau
  /** Alle Befehle für den Aufbau, in Reihenfolge. */
  buildCommands () {
    const { x: cx, y: cy, z: cz } = this.center
    const r = this.radius
    const c = []
    const fill = (x1, y1, z1, x2, y2, z2, block, mode = '') => c.push(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${block}${mode ? ' ' + mode : ''}`)
    /** Ring aus vier Wänden (ohne Boden und Deckel). */
    const ring = (d, y1, y2, block) => {
      fill(cx - d, y1, cz - d, cx + d, y2, cz - d, block); fill(cx - d, y1, cz + d, cx + d, y2, cz + d, block)
      fill(cx - d, y1, cz - d, cx - d, y2, cz + d, block); fill(cx + d, y1, cz - d, cx + d, y2, cz + d, block)
    }
    const holo = (x, y, z, tag, text, color, bold = true) => c.push(`summon armor_stand ${x} ${y} ${z} {Invisible:1b,NoGravity:1b,Marker:1b,CustomNameVisible:1b,Tags:["arena_entity","${tag}"],CustomName:'{"text":"${text}","color":"${color}","bold":${bold}}'}`)

    // Chunks geladen halten, alte Arena-Wesen entfernen
    c.push(`forceload add ${cx - r - 8} ${cz - r - 8} ${cx + r + 8} ${cz + r + 8}`)
    c.push('kill @e[tag=arena_entity]')
    // 1. Bereich freiräumen (in Schichten: ein fill darf höchstens 32768 Blöcke fassen) und Kampfboden
    const o = r + 7
    fill(cx - o, cy - 1, cz - o, cx + o, cy + 5, cz + o, 'air')
    fill(cx - o, cy + 6, cz - o, cx + o, cy + 12, cz + o, 'air')
    fill(cx - o, cy - 2, cz - o, cx + o, cy - 2, cz + o, 'deepslate_tiles')
    fill(cx - r, cy - 1, cz - r, cx + r, cy - 1, cz + r, 'polished_blackstone_bricks')
    for (const [d, block] of [[12, 'chiseled_polished_blackstone'], [5, 'gold_block']]) { fill(cx - d, cy - 1, cz - d, cx + d, cy - 1, cz - d, block); fill(cx - d, cy - 1, cz + d, cx + d, cy - 1, cz + d, block); fill(cx - d, cy - 1, cz - d, cx - d, cy - 1, cz + d, block); fill(cx + d, cy - 1, cz - d, cx + d, cy - 1, cz + d, block) }
    c.push(`setblock ${cx} ${cy - 1} ${cz} sea_lantern`)
    // 2. Mauer, darüber unsichtbare Barriere und ein Barrieren-Deckel gegen Herausfliegen
    fill(cx - r - 1, cy - 1, cz - r - 1, cx + r + 1, cy - 1, cz + r + 1, 'polished_blackstone_bricks', 'replace air')
    ring(r + 1, cy, cy + 1, 'quartz_bricks')
    ring(r + 1, cy + 2, cy + 6, 'barrier')
    fill(cx - r - 1, cy + 7, cz - r - 1, cx + r + 1, cy + 7, cz + r + 1, 'barrier')
    // 3. Tribünen: vier Stufen, abwechselnd Quarz und Karmesinholz
    for (let tier = 1; tier <= 4; tier++) ring(r + 1 + tier, cy, cy + tier, tier % 2 === 0 ? 'smooth_quartz' : 'crimson_planks')
    // 4. Flutlicht-Türme in den vier Ecken (außerhalb der Tribüne)
    const t = r + 6
    for (const [tx, tz] of [[cx - t, cz - t], [cx + t, cz - t], [cx - t, cz + t], [cx + t, cz + t]]) {
      fill(tx, cy - 1, tz, tx, cy + 9, tz, 'polished_basalt')
      c.push(`setblock ${tx} ${cy + 10} ${tz} shroomlight`, `setblock ${tx} ${cy + 11} ${tz} sea_lantern`)
    }
    // Licht in der Arena, damit man im Stream alles sieht (Mitternacht draußen, hell drinnen)
    for (const [lx, lz] of [[-10, -10], [10, -10], [-10, 10], [10, 10], [0, -16], [0, 16], [-16, 0], [16, 0]]) c.push(`setblock ${cx + lx} ${cy - 1} ${cz + lz} sea_lantern`)
    // 5. Hinten rechts (+X, +Z): Smaragd-Maschine
    const fx = cx + 17; const fz = cz + 17
    fill(fx - 1, cy - 1, fz - 1, fx + 1, cy - 1, fz + 1, 'iron_block')
    c.push(`setblock ${fx - 1} ${cy} ${fz + 1} polished_deepslate_wall`, `setblock ${fx + 1} ${cy} ${fz - 1} polished_deepslate_wall`, `setblock ${fx + 1} ${cy} ${fz + 1} redstone_lamp[lit=true]`)
    c.push(`setblock ${fx} ${cy} ${fz} lodestone`, `setblock ${fx} ${cy + 1} ${fz} emerald_block`, `setblock ${fx} ${cy + 3} ${fz} sticky_piston[facing=down]`)
    holo(fx + 0.5, cy + 3.2, fz + 0.5, 'farm_holo', '⚡ AUTO-SMARAGD-MASCHINE ⚡', 'green')
    // 6. Daneben: Schmiede
    const ux = cx + 10; const uz = cz + 18
    fill(ux - 1, cy - 1, uz - 1, ux + 1, cy - 1, uz + 1, 'gilded_blackstone')
    c.push(`setblock ${ux - 1} ${cy} ${uz} smithing_table`, `setblock ${ux} ${cy} ${uz} anvil`, `setblock ${ux + 1} ${cy} ${uz} enchanting_table`)
    holo(ux + 0.5, cy + 2, uz + 0.5, 'upgrade_holo', '⚒ WAFFEN- & RÜSTUNGS-SCHMIEDE ⚒', 'gold')
    // 7. Zuschauer auf drei Rängen: Rüstungsständer mit bunten Lederjacken, in zwei Gruppen für die La-Ola
    for (let tier = 1; tier <= 3; tier++) {
      const d = r + 1 + tier
      const y = cy + tier + 1
      for (let off = -16; off <= 16; off += 4) {
        const col = Math.abs(off / 4 + tier) % FAN_COLORS.length
        const group = (off / 4) % 2 === 0 ? 'fan_a' : 'fan_b'
        for (const s of [{ x: cx + off, z: cz - d, yaw: 0 }, { x: cx + off, z: cz + d, yaw: 180 }, { x: cx - d, z: cz + off, yaw: -90 }, { x: cx + d, z: cz + off, yaw: 90 }]) {
          c.push(`summon armor_stand ${s.x + 0.5} ${y} ${s.z + 0.5} {NoGravity:1b,ShowArms:1b,NoBasePlate:1b,Rotation:[${s.yaw}f,15f],Tags:["arena_entity","arena_fan","${group}","fc${col}"]}`)
        }
      }
    }
    FAN_COLORS.forEach((rgb, i) => c.push(`item replace entity @e[tag=fc${i}] armor.chest with leather_chestplate[dyed_color={rgb:${rgb}}]`))
    c.push('item replace entity @e[tag=arena_fan] armor.legs with leather_leggings', 'item replace entity @e[tag=arena_fan] armor.feet with leather_boots', 'item replace entity @e[tag=arena_fan] armor.head with player_head')
    // 8. Bestenliste als Hologramm an der Nordwand
    const lx = cx + 0.5; const ly = cy + 4; const lz = cz - r + 1.5
    holo(lx, ly + 1.2, lz, 'lb_title', '🏆 TIKTOK LIVE ARENA · TOP SUPPORTER 🏆', 'gold')
    holo(lx, ly + 0.8, lz, 'lb_rank1', '#1 Noch frei', 'yellow', false)
    holo(lx, ly + 0.4, lz, 'lb_rank2', '#2 Noch frei', 'white', false)
    holo(lx, ly, lz, 'lb_rank3', '#3 Noch frei', 'gold', false)
    return c
  }

  /** Arena bauen. Löst auf, wenn alle Befehle abgeschickt sind. */
  async build () {
    const cmds = this.buildCommands()
    this.stopAnimations()
    this.run(cmds)
    this.built = true
    // grob abwarten, bis die Befehls-Warteschlange durch ist (über den Bot: 70 ms pro Befehl)
    await new Promise(resolve => setTimeout(resolve, Math.min(20000, cmds.length * 75 + 500)))
    return cmds.length
  }

  // ---------------------------------------------------------------- Regeln beim Betreten / Verlassen
  enterCommands () {
    const bot = this.botName()
    const { x, y, z } = this.getWaypoints().center
    return [
      'gamerule doMobSpawning false', 'gamerule doDaylightCycle false', 'gamerule doWeatherCycle false', 'gamerule keepInventory true', 'gamerule mobGriefing false',
      'time set midnight', 'weather clear',
      `tp ${bot} ${x} ${y} ${z}`,
      `effect give ${bot} minecraft:saturation infinite 0 true`,
      `effect give ${bot} minecraft:night_vision infinite 0 true`
    ]
  }

  leaveCommands () {
    const bot = this.botName()
    return ['kill @e[tag=arena_mob]', `effect clear ${bot} minecraft:saturation`, `effect clear ${bot} minecraft:night_vision`, `effect clear ${bot} minecraft:strength`, 'gamerule doMobSpawning true', 'gamerule doWeatherCycle true']
  }

  // ---------------------------------------------------------------- Bestenliste, Jubel, Animation
  leaderboardCommands (top = []) {
    const line = (i, medal) => (top[i] ? `${medal} ${cleanName(top[i].name)} (${top[i].score} Pkt)` : `${medal} Noch frei`)
    return [
      `data merge entity @e[tag=lb_rank1,limit=1] {CustomName:'{"text":"${line(0, '🥇')}","color":"yellow","bold":true}'}`,
      `data merge entity @e[tag=lb_rank2,limit=1] {CustomName:'{"text":"${line(1, '🥈')}","color":"white"}'}`,
      `data merge entity @e[tag=lb_rank3,limit=1] {CustomName:'{"text":"${line(2, '🥉')}","color":"gold"}'}`
    ]
  }

  cheerCommands (type = 'ambient') {
    const { x: cx, y: cy, z: cz } = this.center
    if (type === 'kill') return [`playsound minecraft:entity.villager.celebrate master @a ${cx} ${cy} ${cz} 2 1.1`, `particle totem_of_undying ${cx} ${cy + 2} ${cz} 3 2 3 0.2 35 force`]
    if (type === 'boss_spawn') return [`playsound minecraft:event.raid.horn master @a ${cx} ${cy} ${cz} 3 0.9`, `playsound minecraft:entity.ender_dragon.growl master @a ${cx} ${cy} ${cz} 1.5 0.8`]
    if (type === 'upgrade') return [`playsound minecraft:block.anvil.use master @a ${cx + 10} ${cy} ${cz + 18} 2 1.2`, `playsound minecraft:entity.player.levelup master @a ${cx} ${cy} ${cz} 2 1`]
    if (type === 'emerald') return [`playsound minecraft:entity.experience_orb.pickup master @a ${cx + 17} ${cy} ${cz + 17} 1 1.2`, `particle happy_villager ${cx + 17.5} ${cy + 1.6} ${cz + 17.5} 0.4 0.4 0.4 0.05 8 force`]
    return [`playsound minecraft:entity.firework_rocket.launch master @a ${cx} ${cy + 6} ${cz} 1.2 1.2`]
  }

  cheer (type) { this.run(this.cheerCommands(type)) }

  /** Ein Schritt der Dauer-Animation: La-Ola der Zuschauer, Funken an der Maschine. */
  animationCommands (tick) {
    const { x: cx, y: cy, z: cz } = this.center
    const up = '{Pose:{LeftArm:[-145f,0f,-20f],RightArm:[-145f,0f,20f]}}'
    const down = '{Pose:{LeftArm:[-25f,0f,-10f],RightArm:[-25f,0f,10f]}}'
    const c = [
      `execute as @e[tag=fan_a] run data merge entity @s ${tick % 2 === 0 ? up : down}`,
      `execute as @e[tag=fan_b] run data merge entity @s ${tick % 2 === 0 ? down : up}`,
      `particle electric_spark ${cx + 17.5} ${cy + 2.4} ${cz + 17.5} 0.2 0.2 0.2 0.1 5 force`
    ]
    if (tick % 12 === 0) c.push(...this.cheerCommands('ambient'))
    return c
  }

  startAnimations () {
    this.stopAnimations()
    this.animTimer = setInterval(() => { this.run(this.animationCommands(++this.animTick)) }, 1000)
    if (this.animTimer.unref) this.animTimer.unref()
  }

  stopAnimations () { if (this.animTimer) { clearInterval(this.animTimer); this.animTimer = null } }

  // ---------------------------------------------------------------- Gegner
  /**
   * Befehle für einen Supporter-Zombie. Werte wie Leben und Tempo werden per /attribute gesetzt
   * (unabhängig vom NBT-Format der Version).
   * @returns {{cmds: string[], tag: string, at: Vec3}}
   */
  spawnCommands (supporter, isBoss = false) {
    const pts = this.getWaypoints().zombieSpawnPoints
    const at = pts[Math.floor(Math.random() * pts.length)]
    const name = cleanName(supporter)
    const tag = `az${++this.seq}`
    const sel = `@e[tag=${tag},limit=1]`
    const cmds = []
    const base = `Tags:["arena_entity","arena_mob","${tag}"${isBoss ? ',"boss_mob"' : ''}],IsBaby:0b,PersistenceRequired:1b,CanPickUpLoot:0b,CustomNameVisible:1b`
    if (isBoss) {
      cmds.push(`summon zombie ${at.x} ${at.y} ${at.z} {${base},CustomName:'{"text":"👑 BOSS: ${name} 👑","color":"red","bold":true}'}`)
      cmds.push(`attribute ${sel} minecraft:generic.max_health base set 60`, `attribute ${sel} minecraft:generic.movement_speed base set 0.3`, `attribute ${sel} minecraft:generic.knockback_resistance base set 0.4`, `attribute ${sel} minecraft:generic.scale base set 1.5`, `data merge entity ${sel} {Health:60f}`)
      cmds.push(`item replace entity ${sel} weapon.mainhand with diamond_axe`, `item replace entity ${sel} armor.head with carved_pumpkin`, `item replace entity ${sel} armor.chest with diamond_chestplate`, `item replace entity ${sel} armor.legs with diamond_leggings`, `item replace entity ${sel} armor.feet with diamond_boots`)
      cmds.push(...this.cheerCommands('boss_spawn'))
    } else {
      cmds.push(`summon zombie ${at.x} ${at.y} ${at.z} {${base},CustomName:'{"text":"⚔ ${name}","color":"aqua","bold":true}'}`)
      cmds.push(`attribute ${sel} minecraft:generic.movement_speed base set 0.27`, `item replace entity ${sel} armor.head with leather_helmet`)
    }
    return { cmds, tag, at }
  }
}

module.exports = { ArenaBuilder, cleanName, RADIUS }
