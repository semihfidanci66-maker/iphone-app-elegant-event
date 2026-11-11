'use strict'
/**
 * gifts-catalog.js – vorinstallierter Katalog echter TikTok-Live-Gifts (Name, Coins, Standard-Aktion).
 *
 * Icons: Die Original-Bilder liefert TikTok live mit (Gift-Liste des Raums bzw. jedes Gift-Event).
 * Sie werden beim ersten Auftreten in den Katalog übernommen; bis dahin dient das Emoji als Icon.
 * Coin-Preise können sich bei TikTok ändern – der Live-Wert aus dem Event überschreibt den Katalog.
 */

// [id, deutscher Name, englische/alternative Namen, Coins, Emoji, Aktion?, Legende?]
const RAW = [
  ['rose', 'Rose', ['rose'], 1, '🌹', 'zombie_fast', 'Zombie'],
  ['tiktok', 'TikTok', ['tiktok'], 1, '🎵', 'zombie_fast', 'Zombie'],
  ['heart_me', 'Herz-Me', ['heart me'], 1, '💗', 'heal', 'Heilung'],
  ['ice_cream', 'Eistüte', ['ice cream cone', 'ice cream'], 1, '🍦', 'heal', 'Heilung'],
  ['gg', 'GG', ['gg'], 1, '🎮', 'support_random', 'Support-Drop'],
  ['pink_kiss', 'Rosa Kuss', ['kiss', 'pink kiss'], 1, '💋', 'zombie_fast', 'Zombie'],
  ['thumbs_up', 'Daumen hoch', ['thumbs up', 'like'], 1, '👍', 'drop_food', 'Steaks'],
  ['glow_stick', 'Glow Stick', ['glow stick'], 1, '🪄', 'speed', 'Speed II'],
  ['finger_heart', 'Fingerherz', ['finger heart'], 5, '💖', 'skeleton_armored', 'Skelett-Schütze'],
  ['microphone', 'Mikrofon', ['mic', 'microphone'], 5, '🎤', 'skeleton_armored', 'Skelett-Schütze'],
  ['panda', 'Panda', ['panda'], 5, '🐼', 'spawn_mob:spider', 'Spinne'],
  ['friendship_necklace', 'Freundschaftskette', ['friendship necklace'], 10, '📿', 'spawn_mob:husk', 'Wüstenzombies'],
  ['rosa', 'Rosa-Traum', ['rosa'], 15, '🌸', 'drop_bed', 'Bett'],
  ['perfume', 'Parfüm', ['perfume'], 20, '🧴', 'spawn_mob:witch', 'Hexe'],
  ['donut', 'Donut', ['doughnut', 'donut'], 30, '🍩', 'tnt_rain', 'TNT-Drop'],
  ['bouquet', 'Blumenstrauß', ['bouquet', 'flowers'], 30, '💐', 'creeper_duo', 'Creeper-Duo'],
  ['show_heart', 'Zeig-Herz', ['heart signal'], 49, '🫰', 'lightning', 'Blitzeinschlag'],
  ['butterfly', 'Schmetterling', ['butterfly'], 88, '🦋', 'spawn_mob:phantom', 'Phantome'],
  ['guitar', 'Gitarre', ['guitar'], 99, '🎸', 'witch_jockey', 'Hexe + Spinnenreiter'],
  ['paper_crane', 'Papierkranich', ['paper crane'], 99, '🕊️', 'spawn_mob:stray', 'Eiswanderer'],
  ['cap', 'Cap', ['cap', 'hat and mustache'], 99, '🧢', 'drop_armor', 'Eisenrüstung'],
  ['star', 'Stern', ['star'], 99, '⭐', 'drop_weapon', 'Eisenschwert'],
  ['crown', 'Krone', ['crown'], 99, '👑', 'drop_armor', 'Eisenrüstung'],
  ['hand_heart', 'Handherz', ['hand hearts', 'hand heart'], 100, '🫶', 'baby_squad', 'Baby-Zombie-Squad'],
  ['confetti', 'Konfetti', ['confetti'], 100, '🎉', 'tnt_rain', 'TNT-Drop'],
  ['gamepad', 'Gamepad', ['game controller', 'gamepad'], 100, '🕹️', 'drop_weapon', 'Eisenschwert'],
  ['bear_love', 'Bärenliebe', ['bear love'], 100, '🧸', 'support_golem', 'Eisengolem'],
  ['mishka_bear', 'Mishka-Bär', ['mishka bear'], 100, '🐻', 'support_golem', 'Eisengolem'],
  ['sunglasses', 'Sonnenbrille', ['sunglasses'], 199, '🕶️', 'spawn_mob:enderman', 'Endermen'],
  ['ski_goggles', 'Ski-Brille', ['ski goggles'], 199, '🥽', 'spawn_mob:stray', 'Eiswanderer-Trupp'],
  ['corgi', 'Corgi', ['corgi'], 299, '🐕', 'spawn_mob:ravager', 'Verwüster'],
  ['boxing_gloves', 'Boxhandschuhe', ['boxing gloves'], 299, '🥊', 'hit_squad_vindicator', 'Diener-Trupp'],
  ['campfire', 'Lagerfeuer', ['bonfire', 'campfire'], 388, '🔥', 'spawn_mob:blaze', 'Lohen'],
  ['coral', 'Korallen', ['coral'], 499, '🪸', 'spawn_mob:drowned', 'Ertrunkenen-Horde'],
  ['money_gun', 'Money Gun', ['money gun'], 500, '💸', 'hit_squad_vindicator', 'Hit-Squad x10'],
  ['gaming_controller', 'Gaming-Controller', ['gaming keyboard', 'gamer'], 500, '🎮', 'hit_squad_brute', 'Piglin-Barbaren x10'],
  ['swan', 'Schwan', ['swan'], 699, '🦢', 'spawn_mob:wither_skeleton', 'Witherskelette'],
  ['train', 'Zug', ['train'], 899, '🚂', 'hit_squad_brute', 'Piglin-Barbaren x10'],
  ['galaxy', 'Galaxie', ['galaxy'], 1000, '🌌', 'boss_ravager', 'Boss'],
  ['fireworks', 'Feuerwerk', ['fireworks'], 1088, '🎆', 'tnt_rain', 'TNT-Inferno'],
  ['diamond_tree', 'Diamantbaum', ['diamond tree'], 1088, '💎', 'drop_diamond_gear', 'Diamant-Ausrüstung'],
  ['motorcycle', 'Motorrad', ['motorcycle'], 2988, '🏍️', 'boss_wither_skeleton', 'Witherskelett-König'],
  ['private_jet', 'Privatjet', ['private jet', 'airplane'], 4888, '🛩️', 'boss_ravager', 'Boss-Duo'],
  ['sports_car', 'Sportwagen', ['sports car'], 7000, '🏎️', 'boss_warden', 'Wärter'],
  ['yacht', 'Yacht', ['yacht'], 9888, '🛥️', 'boss_warden', 'Wärter'],
  ['falcon', 'Falke', ['falcon'], 10999, '🦅', 'boss_warden', 'Wärter'],
  ['planet', 'Planet', ['planet'], 15000, '🪐', 'boss_warden', 'Wärter + Horde'],
  ['whale_diving', 'Wal-Tauchgang', ['whale diving'], 21500, '🐋', 'boss_warden', 'Wärter + Horde'],
  ['lion', 'Löwe', ['lion'], 29999, '🦁', 'boss_warden', 'Wärter-Duo'],
  ['tiktok_universe', 'TikTok Universe', ['tiktok universe', 'universe'], 44999, '🌠', 'boss_warden', 'Apokalypse']
]

const AMOUNTS = { friendship_necklace: 3, butterfly: 3, paper_crane: 3, sunglasses: 3, ski_goggles: 5, boxing_gloves: 5, campfire: 3, coral: 8, swan: 4, private_jet: 2, lion: 2, fireworks: 8, confetti: 6 }
const HPMULT = { corgi: 1, private_jet: 1.5, yacht: 1.2, falcon: 1.4, planet: 1.6, whale_diving: 1.8, lion: 2, tiktok_universe: 3 }
// Diese acht (zwei volle Seiten im Overlay) stehen standardmäßig in der Overlay-Legende
const LEGEND = new Set(['rose', 'ice_cream', 'finger_heart', 'rosa', 'donut', 'hand_heart', 'money_gun', 'galaxy'])

function buildDefaultRules () {
  return RAW.map(([id, giftName, alt, coins, emoji, actionSpec, legend]) => {
    const [action, mob] = actionSpec.split(':')
    return {
      id, giftName, match: [giftName.toLowerCase(), ...alt], coins, emoji, icon: null, action, mob: mob || null, amount: AMOUNTS[id] || 1, hpMult: HPMULT[id] || 1, legend, enabled: true, inLegend: LEGEND.has(id), custom: false
    }
  })
}

/** Aktion für ein unbekanntes Gift – passend zum Coin-Wert. */
function tierAction (coins) {
  if (coins <= 1) return { action: 'zombie_fast', legend: 'Zombie', amount: 1 }
  if (coins <= 9) return { action: 'skeleton_armored', legend: 'Skelett-Schütze', amount: 1 }
  if (coins <= 49) return { action: 'creeper_duo', legend: 'Creeper-Duo', amount: 1 }
  if (coins <= 99) return { action: 'witch_jockey', legend: 'Hexe + Spinnenreiter', amount: 1 }
  if (coins <= 299) return { action: 'baby_squad', legend: 'Baby-Zombie-Squad', amount: 1 }
  if (coins <= 999) return { action: 'hit_squad_vindicator', legend: 'Hit-Squad', amount: 1 }
  if (coins <= 4999) return { action: 'boss_ravager', legend: 'Boss', amount: 1 }
  return { action: 'boss_warden', legend: 'Wärter', amount: 1 }
}

module.exports = { buildDefaultRules, tierAction, CATALOG_SIZE: RAW.length }
