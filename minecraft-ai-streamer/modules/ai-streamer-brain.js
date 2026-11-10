'use strict'
/**
 * ai-streamer-brain.js – die Streamer-Persona.
 *
 * - Authentischer deutscher Let's-Play-Ton mit drei Stimmungen (chill / hype / panic)
 * - Kurzzeit-Zuschauergedächtnis (viewerMemoryMap): erkennt Wiederholungstäter bei Gifts und Chat
 * - Chat: jede gültige Nachricht wird verarbeitet; Antworten beziehen sich auf den Echtzeit-Zustand des Bots
 * - Gameplay-Wünsche aus dem Chat werden erkannt und als Ziel ganz oben in den Verhaltensbaum gelegt
 * - Anti-Spam: 25 s Cooldown pro Status-Trigger, Idle-Monologe nach 12 s Ruhe
 *
 * Das Modul spricht nicht selbst: es liefert Zeilen { text, emotion } an speakFn (TTS-Pipeline).
 */
const EventEmitter = require('events')

const pick = arr => arr[Math.floor(Math.random() * arr.length)]
const ORD = ['', 'erste', 'zweite', 'dritte', 'vierte', 'fünfte', 'sechste', 'siebte', 'achte', 'neunte', 'zehnte', 'elfte', 'zwölfte']
const ord = (n, suffix = 'r') => n < ORD.length ? ORD[n] + suffix : `${n}.`

const MOB_DE = {
  zombie: 'Zombie', skeleton: 'Skelett', creeper: 'Creeper', spider: 'Spinne', witch: 'Hexe', enderman: 'Enderman', vindicator: 'Diener', piglin_brute: 'Piglin-Barbar', ravager: 'Verwüster', warden: 'Wärter', wither_skeleton: 'Witherskelett', blaze: 'Lohe', husk: 'Wüstenzombie', stray: 'Eiswanderer', drowned: 'Ertrunkener', phantom: 'Phantom', slime: 'Schleim', cave_spider: 'Höhlenspinne', pillager: 'Plünderer', zombified_piglin: 'Zombie-Piglin', piglin: 'Piglin', ghast: 'Ghast', magma_cube: 'Magmawürfel', hoglin: 'Hoglin', tnt: 'TNT', iron_golem: 'Eisengolem'
}
const mobDe = n => MOB_DE[n] || (n ? n.replace(/_/g, ' ') : 'Mob')

// ---------------------------------------------------------------------------- Textbausteine
const L = {
  gift_first: {
    mob: [
      'Ey {user}, danke für {gift}, Bruder... aber musstest du mir echt direkt {spawn} in den Nacken setzen?!',
      '{user} mit {gift}! Danke dir... glaub ich. Da kommt {spawn} auf mich zu, Leute!',
      'Oh nein. {user} schickt {gift} und zack, {spawn} steht vor mir. Na warte!',
      'Willkommen im Chaos, {user}! {gift} ist angekommen und {spawn} direkt mit. Auf geht\'s!'
    ],
    support: [
      '{user}, du bist ein Ehrenmann! {gift} kommt genau richtig, danke dir!',
      'Endlich mal einer, der mir hilft! Danke {user} für {gift}, das rettet mir gerade den Arsch!',
      'Chat, nehmt euch ein Beispiel an {user}! {gift} gleich Support. So geht das!'
    ]
  },
  gift_repeat: {
    mob: [
      '{user} schon wieder! Das ist jetzt {gift} Nummer {n} von dir. Hab ich dir irgendwas getan?!',
      'Ey {user}, Nummer {n}! Du meinst das langsam persönlich, oder?',
      '{user} legt nach, {gift} Nummer {n}! Ich komm ja gar nicht mehr zum Durchatmen!'
    ],
    support: [
      '{user} schon wieder mit Support! Nummer {n}, du bist heute mein Lieblingszuschauer!',
      'Und noch mal {gift} von {user}! Bruder, du trägst mich gerade durch den Stream!'
    ]
  },
  gift_many: {
    mob: [
      '{user} schon wieder! Bruder, hast du heute ein persönliches Problem mit mir?! Das ist schon dein {nth} {mob}, lass mich doch erstmal {doing}!',
      'Nein, nein, nein! {user} zum {nth_n} Mal! Wie viele Coins hast du eigentlich, Junge?! Ich wollte nur {doing}!',
      '{user}, Gift Nummer {n}! Ich schwöre, ich bau dir ein Denkmal... direkt neben meinem Grab!'
    ],
    support: [
      '{user} zum {nth_n} Mal mit Support! Ohne dich wär ich schon dreimal tot, safe!',
      'Leute, {user} ist heute mein Schutzengel. Gift Nummer {n}, danke Bruder!'
    ]
  },
  gift_big: [
    'ALARM! {user} haut {gift} raus! {coins} Coins! Chat, es wird ernst, {spawn} ist unterwegs!',
    'Was?! {gift} von {user}?! Leute, das ist kein Spaß mehr, da kommt {spawn}! Betet für mich!',
    'OH MEIN GOTT, {user}! {gift}! Okay okay okay, Schild hoch, Schwert raus, {spawn} kommt!'
  ],
  gift_boss: [
    'NEIN! {user} schickt die {gift}! Tausend Coins! Chat, der Endboss kommt, das war\'s mit meinem Haus!',
    'Leute... {user} hat gerade {gift} geschickt. Ich hab Gänsehaut. {spawn} spawnt! Jetzt wird\'s episch!'
  ],
  combo: [
    '{user} mit der Combo! Mal {count}! Hör auf, hör auf, hör auf!',
    'Combo mal {count} von {user}! Das ist doch nicht mehr normal!',
    'Mal {count}! {user} drückt einfach den Knopf durch, Leute!'
  ],
  follow: ['Danke fürs Folgen, {user}! Willkommen in der Community!', '{user} folgt jetzt, stark! Bleib dran, hier passiert gleich was!'],
  like_burst: ['Danke für die Likes, Chat! Lasst das Herz weiter glühen!', 'Die Likes fliegen, ihr seid stark heute!'],
  share: ['{user} teilt den Stream, Ehre! Danke dir!'],
  greet: ['Hey {user}, grüß dich! Schön, dass du da bist!', 'Moin {user}! Mach\'s dir bequem, hier geht\'s gerade ab!', 'Servus {user}, willkommen im Stream!'],
  greet_again: ['{user}, du schon wieder, schön dich zu sehen!', 'Ah, {user} ist auch noch da, stark!'],
  what_doing: {
    wood: ['Hey {user}! Ich hack hier gerade Bäume, ohne Holz läuft in Minecraft gar nichts. {inv_wood}', 'Holz farmen, {user}! Ganz klassisch, Baum für Baum.'],
    craft: ['Bin gerade an der Werkbank, {user}. {goal} steht an.', '{user}, ich crafte gerade. Gleich hab ich neues Werkzeug!'],
    mine: ['Hey {user}! Ich grab mich hier gerade auf Ebene {y} runter, {mine_reason}', '{user}, ich bin unter Tage auf Ebene {y}. Schöne Treppe, niemals gerade nach unten graben, merkt euch das!'],
    hunt: ['Ich bin auf der Jagd, {user}! Der Magen knurrt, ich brauch Steaks.', '{user}, ich jage gerade Abendessen. Sorry an alle Kühe im Chat.'],
    smelt: ['Der Ofen läuft, {user}! Ich pass solange auf, dass mir keiner in den Rücken fällt.', '{user}, ich schmelze gerade. In der Zwischenzeit sortier ich mein Inventar.'],
    build: ['Ich bau gerade mein Haus, {user}! Block für Block, das wird richtig gemütlich.', '{user}, Hausbau ist angesagt! Fundament, Wände, Dach. Wehe, einer schickt jetzt TNT!'],
    enchant: ['Ich bin am Verzauberungstisch, {user}! Gleich gibt\'s Schärfe aufs Schwert, hoffentlich.'],
    portal: ['Ich bau gerade das Netherportal, {user}! Obsidian für Obsidian.'],
    nether: ['{user}, ich bin im Nether! Überall Lava, ich muss mich konzentrieren. Wir suchen eine Festung!'],
    combat: ['Ich kämpfe gerade, {user}! {threats} Gegner, keine Zeit zum Quatschen!', 'Was ich mache, {user}?! Überleben! Hier sind {threats} Mobs hinter mir her!'],
    eat: ['Kurze Essenspause, {user}. Auch ein Streamer muss mal was futtern.'],
    sleep: ['Ich leg mich gerade hin, {user}. Spawnpunkt setzen ist wichtig!'],
    explore: ['Ich erkunde gerade die Gegend, {user}. Mal schauen, was es hier so gibt.'],
    recover: ['Ich hol mir gerade meine Sachen zurück, {user}. Fünf Minuten, dann despawnt alles!'],
    idle: ['Gerade ist es ruhig, {user}. Ich räum ein bisschen in der Basis auf.'],
    offline: ['{user}, ich bin gerade gar nicht in der Welt. Sekunde, ich verbinde mich neu.'],
    paused: ['Ich mach gerade kurz Pause, {user}. Gleich geht\'s weiter!']
  },
  how_are_you: {
    fight: ['Mir geht\'s gar nicht gut, {user}! Hier rennen {threats} Mobs hinter mir her{shield_part}! Hilf mir lieber!', 'Frag nicht, {user}! {threats} Gegner am Hals und nur noch {hp} Herzen!'],
    low: ['Ehrlich, {user}? Schlecht. Ich hab nur noch {hp} Herzen und {food_part}.', 'Geht so, {user}. {hp} Herzen sind nicht viel, ich muss dringend was essen.'],
    good: ['Mir geht\'s bestens, {user}! Volle Herzen, {mood_extra}', 'Läuft bei mir, {user}! {mood_extra} Und bei dir?', 'Alles entspannt, {user}. {mood_extra}'],
    night: ['Geht, {user}. Es ist Nacht, da bin ich immer ein bisschen nervös. Überall knurrt es.']
  },
  where: ['Ich bin gerade bei X {x}, Z {z} auf Höhe {y}, {user}. {dimension_part}'],
  hp: ['Ich hab gerade {hp} von zehn Herzen und {foodbar} von zehn Keulen, {user}.'],
  who: ['Ich bin die KI hier im Stream, {user}! Ich spiel Minecraft Survival komplett selbst, und ihr macht mir mit euren Gifts das Leben schwer.', 'Ja {user}, ich bin eine KI. Aber ich hab mehr Game Sense als so mancher Mensch, glaub mir!'],
  compliment: ['Danke {user}, das geht runter wie Öl!', 'Du bist ein Ehrenmann, {user}, danke dir!', 'Ey danke, {user}! Chat, so macht man das!'],
  insult: ['Ganz ruhig, {user}. Komm du erstmal mit zehn Zombies im Nacken klar!', '{user} flamet im Chat, während ich hier ums Überleben kämpfe. Stabil.', 'Ich hab dich auch lieb, {user}.'],
  laugh: ['Ja ja, lach du nur, {user}!', 'Schön, dass wenigstens einer Spaß hat, {user}!'],
  generic: {
    calm: ['Gute Frage, {user}! Ich bin gerade bei: {activity_short}. Schreib mir, was ich als Nächstes machen soll!', 'Hey {user}, ich hab dich gelesen! Gerade heißt es: {activity_short}.', '{user} im Chat! Bleib dran, gleich wird\'s spannend.', 'Ich seh dich, {user}! Was meint ihr, Chat, hat {user} recht?'],
    fight: ['Gleich, {user}, gleich! Erst die Mobs, dann der Chat!', '{user}, ich les dich, aber ich kämpf gerade um mein Leben!']
  },
  goal_ack: {
    wood: ['Alles klar {user}, ich hol Holz! Kann man nie genug haben.', 'Ansage von {user}: Holz farmen! Mach ich sofort.'],
    house: ['Ansage von {user} im Chat: Wir bauen ein Haus! Das wird die schönste Hütte auf dem ganzen Server!', 'Stimmt, {user}, ich brauch endlich ein Dach über dem Kopf. Hausbau startet!'],
    iron_sword: ['{user} will ein Eisenschwert sehen? Bekommst du! Ich besorg Eisen und schmiede das Ding.', 'Gute Idee, {user}! Mit Stein kloppt man sich nicht ewig. Eisenschwert kommt!'],
    iron: ['Eisen farmen, verstanden {user}! Ab in die Mine.'],
    nether: ['Ansage von {user} im Chat: Wir gehen jetzt offiziell in den Nether! Macht euch bereit!', '{user} schickt mich in den Nether! Okay Leute, das wird heiß. Ich bereite alles vor!'],
    portal: ['{user} will das Portal sehen! Ich kümmer mich um Obsidian.'],
    diamonds: ['Diamanten, {user}? Sag das doch gleich! Ab auf Ebene minus vierundfünfzig!', 'Ansage von {user}: Diamanten suchen! Drückt die Daumen, Chat!'],
    enchant: ['{user} will Verzauberungen sehen! Ich arbeite mich zum Verzauberungstisch vor.'],
    eat: ['Stimmt eigentlich {user}, mein Hunger ist echt unten, ich kümmere mich sofort ums Essen!', 'Guter Punkt, {user}! Erstmal was futtern.'],
    hunt: ['Jagen gehen, alles klar {user}! Ich brauch eh Steaks.'],
    mine: ['Ab in die Mine, {user}! Spitzhacke raus!', '{user} schickt mich unter Tage. Treppe graben und los!'],
    sleep: ['Du hast recht, {user}, ich sollte schlafen gehen. Ab ins Bett!'],
    tidy: ['Inventar aufräumen, gute Idee {user}! Hier sieht\'s aus wie bei Hempels.'],
    corpse: ['Du hast recht, {user}! Ich hol sofort meinen Loot zurück!'],
    bed: ['Ein Bett, gute Idee {user}! Ich such mir drei Schafe.'],
    gear: ['Stimmt {user}, ich leg erstmal vernünftige Ausrüstung an!']
  },
  goal_already: ['Hab ich schon erledigt, {user}! {label} ist längst abgehakt.', '{user}, da bin ich dir einen Schritt voraus: {label} ist schon fertig!'],
  goal_busy: ['Mach ich, {user}! Aber erst muss ich hier überleben!', 'Notiert, {user}! Sobald die Mobs weg sind, geht\'s los.'],
  goal_offline: ['Würd ich gern machen, {user}, aber ich bin gerade nicht in der Welt.'],
  goal_done: ['Check! {label} ist erledigt{by_part}!', '{label}: abgehakt{by_part}! Was kommt als Nächstes, Chat?'],
  goal_failed: ['Okay Leute, {label} hat gerade nicht geklappt. Ich versuch\'s später noch mal.'],

  live_connected: ['So Chat, die Verbindung steht! Wir sind live drin – wehe, ihr eskaliert heute wieder mit den Rosen!'],
  gift_discovered: ['Oha, {gift} kannte ich noch gar nicht! Ist ab sofort im Katalog, danke {user}!'],
  callout_weapon: [
    'Chat, das sind viel zu viele {mobs} für {weapon}! {iron_part}schickt mir schnell {gift}, damit ich {gear} bekomme!',
    'Leute, {threats} {mobs} und ich steh hier mit {weapon_dat}! {iron_part}mit {gift} könnt ihr mir {gear} schicken!'
  ],
  callout_weapon_nogift: ['Chat, das sind viel zu viele {mobs} für {weapon}! {iron_part}drückt mir die Daumen!'],
  callout_heal: ['Chat, ich hab nur noch {hp} Herzen und nichts zu essen! Schickt mir {gift}, das heilt mich sofort!', 'Ich brauch Hilfe, Leute! {hp} Herzen! Einmal {gift} bitte, sonst war es das!'],
  callout_food: ['Mein Magen ist komplett leer, Chat! Wer {gift} schickt, rettet mich vor dem Verhungern!'],
  sleep_start: ['Es wird dunkel, Chat! Schnell ins Bett, Spawnpunkt sichern und Nacht überspringen!', 'Nacht bricht an, Leute. Ab ins Bett, bevor die Monster kommen. Spawnpunkt wird gesetzt!'],
  sleep_thunder: ['Gewitter, Chat! Da schlaf ich lieber, bevor mich noch ein Blitz erwischt.'],
  sleep_failed: ['Ich kann nicht schlafen, hier sind Monster in der Nähe! Erst aufräumen.'],
  wake: ['Guten Morgen, Chat! Nacht übersprungen, Spawnpunkt sitzt. Weiter geht es!'],
  bed_crafted: ['Bett ist gecraftet! Danke an die drei Schafe. Ab jetzt wird jede Nacht geschlafen.'],
  corpse_run_start: ['Nein, ich bin gestorben! Sofort zurück zu meinem Loot, bevor meine Sachen despawnen!', 'Tot! Aber noch ist nichts verloren. {secondsLeft} Sekunden, dann despawnt alles. Rennen, rennen, rennen!'],
  corpse_run_done: { ok: ['JA! Ich hab meinen Loot wieder! Alles eingesammelt, Rüstung ist wieder an. Chat, das war knapp!', 'Geschafft! Alle Sachen zurück im Inventar. Wir sind wieder im Spiel, Leute!'], fail: ['Mein Loot ist weg. Okay. Dann fangen wir halt noch mal von vorne an. Charakterbildend.'] },
  corpse_run_none: ['Da gibt es gerade nichts mehr zu holen, Leute. Entweder bin ich nicht gestorben oder der Loot ist schon weg.'],
  camera: { third: ['Kamera raus, das will ich von außen sehen!'], ego: [] },

  // ---- Bot-Ereignisse ----
  plan: ['Neuer Plan, Leute: {goal}! Dafür mach ich jetzt: {steps}.', 'So, nächstes Ziel: {goal}. Erster Schritt: {first}.'],
  tree_done: ['So, der Baum ist weg. {total} Stämme im Inventar, das läuft!', 'Wieder ein Baum gefällt, und natürlich wird nachgepflanzt. Wir sind ja keine Tiere.'],
  craft_tool: ['Frisch gecraftet: {items}! Jetzt geht\'s vorwärts.', 'Neues Equipment, Chat: {items}!'],
  station_packed: ['Und die Werkbank nehm ich wieder mit. Ich lass doch keinen Müll in der Welt stehen!', 'Werkbank wieder eingepackt. Ordnung muss sein.'],
  mine_start: ['Okay, ab nach unten. Schöne Treppe, niemals gerade runter graben, das ist Regel Nummer eins!', 'Spitzhacke raus, wir graben uns runter Richtung Ebene {targetY}.'],
  ore_found: {
    diamond: ['DIAMANTEN! Chat, da sind Diamanten! Jetzt bloß keine Lava drumherum!', 'Leute! Diamanten auf Ebene {y}! Ich bau die ganze Ader ab!'],
    iron: ['Eisen! Genau das hab ich gebraucht. Die ganze Ader kommt mit.', 'Da ist Eisen in der Wand. Ich nehm alles mit, jeden einzelnen Block.'],
    coal: ['Kohle, sehr gut. Fackeln und Brennstoff sind gesichert.'],
    gold: ['Gold! Das wird meine Piglin-Versicherung für den Nether.'],
    lapis: ['Lapis! Perfekt fürs Verzaubern.'],
    redstone: ['Redstone. Nehm ich mit, schadet nie.'],
    other: ['Erz gefunden, das nehm ich komplett mit.']
  },
  vein_done: ['{count} mal {label} aus einer Ader, nicht schlecht!', 'Ader komplett abgebaut: {count} mal {label}. Nichts liegen lassen!'],
  lava: ['Lava! Zurück, zurück! Schnell einen Block davor!', 'Oha, Lava direkt vor mir. Block rein und zu. Das war knapp, Chat!'],
  mine_return: ['So, Inventar ist gut gefüllt. Ich geh wieder hoch an die Oberfläche.'],
  hunt_kill: ['Sorry, {label}. Aber ich hab Hunger.', 'Ein {label} weniger, ein Steak mehr.'],
  smelt_start: [
    'So, erstmal {count} mal {item_de} in den Ofen schmeißen. {fuel_part}Chat, wehe einer von euch schickt jetzt nen Donut, während ich am Ofen stehe!',
    '{count} Stück {item_de} sind im Ofen. Ich steh hier nicht blöd rum, ich sortier solange mein Inventar.'
  ],
  smelt_done: ['Ofen ist durch! Alles rausgeholt, weiter geht\'s.', 'Fertig geschmolzen. Der Ofen kommt wieder ins Inventar, wir lassen nichts stehen.'],
  gear: ['Neues Equipment, Chat: {items}! Jetzt bin ich gefährlich.', 'Upgrade! {items}. Kommt ruhig, ihr Zombies!'],
  shield_get: ['Und da ist das Schild! Ab jetzt blocke ich Creeper weg, als wär\'s nichts.'],
  build_site: ['Hier! Schön flach, hier kommt mein Haus hin.', 'Der Platz ist perfekt. Hier wird gebaut, Leute!'],
  build_progress: {
    0: ['Erstmal das Fundament. Sieben mal sieben aus Bruchstein, solide Basis.'],
    1: ['Fundament steht! Jetzt die Eckpfeiler und der Steinsockel.'],
    2: ['Die Wände wachsen. Fenster auf Augenhöhe, ich will ja sehen, wer draußen rumläuft.'],
    3: ['Letzte Wandreihe, gleich kommt das Dach.'],
    4: ['Jetzt das Dach. Komplett zu, damit mir keine Spinne reinklettert.'],
    5: ['Tür rein und Fackeln an die Wand. Sieht schon richtig nach Zuhause aus!'],
    6: ['Einrichtung! Werkbank, Öfen, Kiste und ein Bett. Feng Shui auf Minecraft-Art.']
  },
  build_done: ['Leute, das Haus steht! Ist das schön oder ist das schön? Schreibt mal eine Eins in den Chat, wenn es euch gefällt!', 'Fertig! Mein eigenes Haus. Und wehe, irgendjemand schickt jetzt TNT!'],
  build_paused: ['Mir geht das Material aus. Ich muss noch mal {missing} besorgen, dann bau ich weiter.'],
  sleep: ['Gute Nacht, Chat. Kurz hinlegen, Spawnpunkt ist gesetzt.'],
  enchanted: ['JA! {enchantLabel} auf {itemLabel}! Chat, habt ihr das gesehen?!', 'Leute, schaut euch das an: {itemLabel} mit {enchantLabel}! Jetzt wird\'s ernst für die Mobs!'],
  enchant_table: ['Der Verzauberungstisch steht! Jetzt brauch ich nur noch Level und Lapis.'],
  obsidian: ['Obsidian Nummer {count}. Das dauert ewig mit dem Zeug, aber was muss, das muss.'],
  portal_lit: ['Das Portal brennt! Lila Wirbel, Leute! Wer kommt mit in den Nether?'],
  nether_enter: {
    gold: ['Goldstiefel sind an, damit die Piglins mich in Ruhe lassen. Und rein ins Portal!'],
    nogold: ['Ich hab kein Gold an, das wird riskant mit den Piglins. Augen zu und durch!']
  },
  nether_arrived: ['Willkommen im Nether, Chat! Alles rot, alles heiß, überall Lava. Vorsichtig jetzt.'],
  fortress_found: ['Da! Eine Netherfestung! Jetzt Schild hoch, hier gibt es Lohen.'],
  nether_home: ['Wieder zu Hause! {rods} Lohenruten im Gepäck. Was ein Trip!'],
  nether_retreat: ['Ich brech die Expedition ab, Leute. Zu wenig Vorräte, das ist mir zu heiß.'],
  combat_start: {
    gift: ['Da ist er, der {mob} von {donor}! Komm her!', '{donor}s {mob} ist da. Okay, Schwert raus!'],
    many: ['{count} Gegner auf einmal! Ruhig bleiben, schön strafen!', 'Oh, das sind {count}! Okay, nicht umzingeln lassen!'],
    one: ['Ein {mob}! Den nehm ich mir vor.', 'Da kommt ein {mob}. Sauberer Crit und fertig.']
  },
  kill_gift: ['Und weg ist der {mob} von {donor}! War das alles, {donor}?', '{donor}, dein {mob} ist Geschichte! Schick was Besseres!', 'Erledigt! Sorry {donor}, dein {mob} hat nicht lange gehalten.'],
  kill: ['Erledigt!', 'Und tschüss!', 'Sauberer Crit!', 'Der hat gesessen!'],
  crit: ['Crit! Habt ihr das gesehen?'],
  shield: {
    creeper: ['Creeper! Schild hoch! ... Geblockt! Nichts passiert, Chat!', 'SCHILD! Creeper explodiert direkt vor mir und ich steh noch!'],
    arrow: ['Pfeil geblockt! Das Skelett zielt nicht schlecht.'],
    fireball: ['Feuerball geblockt! Danke, Schild!']
  },
  kite: ['Zu viele auf einmal! Ich zieh die in eine Reihe, dann kommen sie einzeln!', 'Umzingelt! Kurz zurück, dann kommen sie schön hintereinander.'],
  low_hp: ['Ich hab nur noch {hp} Herzen! Rückzug, ich muss essen!', 'Wenig Leben, wenig Leben! Kurz weg hier und was essen!'],
  critical_hp: ['Leute, ich sterbe gleich! Nur noch {hp} Herzen!'],
  ate_pressure: ['Gegessen! Okay, zurück in den Kampf!'],
  ate: ['Mmh, {item_de}. Das tat gut.'],
  hurt_creeper: ['AAH! Creeper!'],
  death: [
    'NEIN! Das darf doch nicht wahr sein! Ich bin tot. Tod Nummer {deaths}, danke Chat!',
    'Tot. Einfach tot. Okay, okay, tief durchatmen. Ich hol mir meine Sachen zurück!',
    'Ich bin gestorben! Fünf Minuten, bevor mein Loot despawnt. Los, los, los!'
  ],
  recover_done: { ok: ['Puh, ich hab meine Sachen wieder! Alles noch da.'], fail: ['Mein Loot ist weg. Okay. Dann fangen wir halt noch mal von vorne an. Charakterbildend.'] },
  stuck: {
    hole: ['Ich steck in einem Loch! Moment, Block unter die Füße und hochpillern.', 'Wer hat mich in das Loch geschubst?! Kurz rauspillern.'],
    other: ['Ich häng irgendwo fest. Sekunde.']
  },
  night: ['Es wird dunkel, Leute. Jetzt kommen die Monster raus. Augen auf!', 'Die Sonne geht unter. Ab jetzt wird jeder Schritt gefährlich.'],
  day: ['Die Sonne geht auf! Nacht überlebt, Chat!'],
  pickup_diamond: ['Diamant eingesammelt! Jeder einzelne zählt.'],
  no_op: ['Leute, kleiner Technik-Hinweis: Mir fehlen gerade die Rechte, um eure Gift-Mobs zu spawnen.'],
  idle: {
    wood: ['Holz, Holz, Holz. Der Anfang von jedem Survival-Run. Wer von euch pflanzt eigentlich auch immer nach?', 'Schöner Wald hier. Ich nehm nur die normalen Bäume, die Riesendinger dauern mir zu lange.'],
    mine: ['Ebene {y}. Alle acht Blöcke eine Fackel an die rechte Wand, dann find ich auch wieder raus.', 'Ich schau mich lieber alle paar Sekunden um. Creeper im Tunnel sind das Schlimmste, was es gibt.', 'Stein, Stein, Stein. Irgendwo hier muss doch Erz sein. Chat, wie tief würdet ihr gehen?'],
    build: ['Block für Block. Ein Haus muss ordentlich aussehen, da bin ich pingelig.', 'Was meint ihr, Chat: noch einen Balkon dran? Nee, erstmal das Dach.'],
    smelt: ['Der Ofen arbeitet, ich arbeite. So macht man das, statt sechzig Sekunden ins Feuer zu starren.'],
    hunt: ['Wo sind denn die ganzen Kühe hin? Kaum hat man Hunger, sind alle weg.'],
    explore: ['Mal schauen, was hinter dem Hügel ist. Ich liebe es, neue Gegenden zu erkunden.', 'Schöne Landschaft. Hier könnte man auch gut ein Haus hinstellen.'],
    craft: ['Kurz das Inventar im Kopf sortieren. Schwert auf die Eins, Spitzhacke auf die Zwei, wie es sich gehört.'],
    nether: ['Im Nether gilt: Niemals nach unten graben und immer auf die Kanten achten.'],
    idle: ['Gerade ist es verdächtig ruhig, Chat. Das gefällt mir gar nicht.', 'Na Chat, was soll ich als Nächstes machen? Schreibt es rein, ich hör auf euch!'],
    generic: ['Chat, es ist so still. Plant ihr was? Ihr plant doch was.', 'Kurze Erinnerung: Mit einer Rose schickt ihr mir einen Zombie, mit der Eistüte könnt ihr mir helfen. Nur so als Tipp.', 'Wer neu hier ist: Ich bin eine KI und spiele komplett selbst. Ihr entscheidet mit euren Gifts, wie schwer ich es habe!']
  }
}

const ITEM_DE = {
  raw_iron: 'Roheisen', raw_gold: 'Rohgold', beef: 'Rindfleisch', porkchop: 'Schweinefleisch', mutton: 'Hammelfleisch', chicken: 'Hühnchen', sand: 'Sand', cooked_beef: 'Steak', cooked_porkchop: 'Kotelett', cooked_mutton: 'Hammelbraten', cooked_chicken: 'Brathähnchen', bread: 'Brot', golden_apple: 'Goldapfel', iron_ingot: 'Eisenbarren',
  wooden_pickaxe: 'Holzspitzhacke', wooden_sword: 'Holzschwert', wooden_axe: 'Holzaxt', stone_pickaxe: 'Steinspitzhacke', stone_sword: 'Steinschwert', stone_axe: 'Steinaxt', stone_shovel: 'Steinschaufel', furnace: 'Ofen', iron_pickaxe: 'Eisenspitzhacke', iron_sword: 'Eisenschwert', shield: 'Schild', bucket: 'Eimer', iron_chestplate: 'Eisenbrustplatte', iron_helmet: 'Eisenhelm', iron_leggings: 'Eisenhose', iron_boots: 'Eisenstiefel', iron_axe: 'Eisenaxt', diamond_pickaxe: 'Diamantspitzhacke', diamond_sword: 'Diamantschwert', diamond_chestplate: 'Diamantbrustplatte', golden_boots: 'Goldstiefel', flint_and_steel: 'Feuerzeug'
}
const itemDe = n => ITEM_DE[n] || (/_bed$/.test(n) ? 'Bett' : n.replace(/_/g, ' '))
const KIND_DE = { cobble: 'Bruchstein', log: 'Stämme', planks: 'Planken', slab: 'Stufen', window: 'Fenster', door: 'eine Tür', chest: 'Kisten', furnace: 'Öfen', crafting_table: 'eine Werkbank' }

// Gameplay-Wünsche aus dem Chat
const GOAL_PATTERNS = [
  ['nether', /\b(nether|netherportal|hölle)\b/i],
  ['house', /\b(haus|h[üu]tte|base|basis|unterschlupf|shelter)\b.*\b(bau|mach|errichte)|\bbau\w*\b.*\b(haus|h[üu]tte|base|basis)\b/i],
  ['iron_sword', /\b(eisenschwert|eisen ?schwert|iron ?sword)\b/i],
  ['diamonds', /\b(diamant\w*|dias?|diamonds?)\b/i],
  ['enchant', /\b(verzauber\w*|enchant\w*|zaubertisch)\b/i],
  ['wood', /\b(holz|b[äa]ume?|wood)\b.*\b(hol|hack|f[äa]ll|farm|sammel|geh)|\b(hol|hack|f[äa]ll|farm|sammel)\w*\b.*\b(holz|b[äa]ume?)\b/i],
  ['iron', /\b(eisen|iron)\b.*\b(hol|farm|such|sammel|mine)|\b(such|farm|hol)\w*\b.*\beisen\b/i],
  ['eat', /\b(iss|ess|essen|futter\w*|friss)\b.*\b(was|mal|etwas|endlich)|\b(iss|friss) ?(doch|mal|was)|\bdu (musst|solltest) (was )?essen\b|\bhunger\b/i],
  ['hunt', /\b(jag\w*|kuh|k[üu]he|schwein\w*|tiere?)\b.*\b(jag|t[öo]te|schlacht|kill|hol)|\bgeh\w* jagen\b/i],
  ['mine', /\b(mine\w*|minen|bergbau|grab\w*|h[öo]hle)\b.*\b(geh|runter|mal|los)|\bgeh\w*\b.*\b(mine|minen|h[öo]hle|runter)\b/i],
  ['corpse', /\b(hol|sammel|rette|such)\w*\b.*\b(loot|sachen|items|zeug|inventar)\b|\bcorpse ?run\b/i],
  ['sleep', /\b(schlaf\w*|bett|penn\w*)\b.*\b(geh|leg|mal)|\bgeh\w* (schlafen|pennen|ins bett)\b/i],
  ['tidy', /\b(inventar|hotbar|kiste)\b.*\b(aufr[äa]um|sortier|ordne)|\br[äa]um\w* (mal )?auf\b/i]
]

class StreamerBrain extends EventEmitter {
  /**
   * @param {{ speak: (line: {text: string, emotion: string, id: number, kind: string}) => Promise<number>|number,
   *           getStatus: () => object, pushGoal: (id: string, by: string) => object, onAddress?: () => void,
   *           streamerName?: string }} deps
   */
  constructor (deps) {
    super()
    this.deps = deps
    this.viewerMemoryMap = new Map()
    this.queue = []
    this.busyUntil = 0
    this.speaking = false
    this.cooldowns = new Map()
    this.recentLines = []
    this.lastExternal = Date.now() // letzter Gift/Chat
    this.lastSpoke = 0
    this.lineId = 0
    this.likeCount = 0
    this.enabled = true
    this.lastStage = -1
    this.timer = null // kein eigener Timer: tick() hängt am zentralen Game-Loop
    this.tickN = 0
  }

  dispose () {}
  /** Vom zentralen 250-ms-Loop aufgerufen. */
  tick () { this._tick(); if (++this.tickN % 4 === 0) this.tacticalCallout() }
  status () { return this.deps.getStatus() || { connected: false, activity: 'offline' } }

  // ---------------------------------------------------------------- Zuschauergedächtnis
  viewer (v) {
    const id = String(v.uniqueId || v.nickname || 'anonym').toLowerCase()
    let m = this.viewerMemoryMap.get(id)
    if (m) this.viewerMemoryMap.delete(id) // LRU: zuletzt gesehene wandern ans Ende
    else m = { id, name: this.speakable(v.nickname || v.uniqueId || 'Unbekannt'), gifts: {}, totalGifts: 0, coins: 0, chats: 0, firstSeen: Date.now(), lastSeen: 0, greeted: false, goals: 0 }
    this.viewerMemoryMap.set(id, m)
    // harte Obergrenze 200 Einträge -> RAM bleibt über 12+ Stunden flach
    while (this.viewerMemoryMap.size > 200) this.viewerMemoryMap.delete(this.viewerMemoryMap.keys().next().value)
    m.lastSeen = Date.now()
    return m
  }

  /** Namen aussprechbar machen: "xX_Lukas_99" -> "Lukas" */
  speakable (name) {
    let n = String(name).replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '').replace(/^[@\s]+/, '')
    n = n.replace(/[_.\-]+/g, ' ').replace(/\d{2,}/g, ' ').replace(/\b[xX]{1,3}\b/g, ' ').replace(/\s+/g, ' ').trim()
    if (n.length < 2) n = String(name).replace(/[^\p{L}\p{N} ]/gu, '').trim() || 'Unbekannt'
    if (n.length > 18) n = n.split(' ')[0].slice(0, 18)
    return n.charAt(0).toUpperCase() + n.slice(1)
  }

  // ---------------------------------------------------------------- Sprechen
  cooldown (key, ms = 25000) {
    const now = Date.now()
    if ((this.cooldowns.get(key) || 0) > now) return false
    this.cooldowns.set(key, now + ms)
    return true
  }

  fill (tpl, vars) {
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : '')).replace(/\s+([!?.,])/g, '$1').replace(/\s{2,}/g, ' ').trim()
  }

  /** Zeile aus einem Pool wählen, ohne direkte Wiederholung. */
  line (pool, vars = {}) {
    if (!pool || !pool.length) return null
    const fresh = pool.filter(t => !this.recentLines.includes(t))
    const tpl = pick(fresh.length ? fresh : pool)
    this.recentLines.push(tpl)
    if (this.recentLines.length > 40) this.recentLines.shift()
    return this.fill(tpl, vars)
  }

  /**
   * @param {string} text
   * @param {{emotion?: 'chill'|'hype'|'panic', priority?: number, kind?: string, ttl?: number}} o
   */
  say (text, o = {}) {
    if (!text || !this.enabled) return false
    const item = { id: ++this.lineId, text, emotion: o.emotion || 'chill', priority: o.priority ?? 1, kind: o.kind || 'misc', at: Date.now(), ttl: o.ttl ?? 9000 }
    // Der Streamer hängt nie mehr als ein paar Sätze hinterher: Unwichtiges fliegt raus
    this.queue.push(item)
    this.queue.sort((a, b) => b.priority - a.priority || a.at - b.at)
    while (this.queue.length > 4) this.queue.pop()
    return true
  }

  _tick () {
    const now = Date.now()
    if (!this.speaking && now >= this.busyUntil) {
      this.queue = this.queue.filter(i => now - i.at <= i.ttl)
      const item = this.queue.shift()
      if (item) this._speak(item)
      else this._maybeMonologue(now)
    }
  }

  async _speak (item) {
    this.speaking = true
    this.lastSpoke = Date.now()
    try {
      const dur = await this.deps.speak(item)
      this.busyUntil = Date.now() + (Number(dur) || this.estimate(item.text)) + 250
    } catch (e) {
      this.busyUntil = Date.now() + 500
      this.emit('error', e)
    } finally {
      this.speaking = false
      this.lastSpoke = Date.now()
    }
  }

  estimate (text) { return Math.max(1200, text.length * 62) }

  // ---------------------------------------------------------------- Zustandstexte
  stateVars (v = {}) {
    const s = this.status()
    const inv = s.inv || {}
    const hp = Math.max(0, Math.round((s.health ?? 20) / 2 * 2) / 2)
    const act = s.activity || 'offline'
    const mineReason = inv.pickTier >= 3 ? 'wir brauchen dringend Diamanten für die nächste Galaxie-Welle!' : inv.pickTier >= 2 ? 'ich such Eisen für Schwert und Schild!' : 'ich brauch erstmal Stein für vernünftiges Werkzeug!'
    const doing = { wood: 'in Ruhe Holz hacken', mine: 'in Ruhe minen', build: 'mein Haus zu Ende bauen', smelt: 'mein Eisen schmelzen', hunt: 'was zu essen jagen', craft: 'in Ruhe craften', enchant: 'verzaubern', portal: 'mein Portal bauen', nether: 'den Nether überleben', explore: 'die Gegend erkunden', eat: 'was essen', sleep: 'schlafen' }[act] || 'durchatmen'
    const short = { wood: 'Holz hacken', mine: `Minen auf Ebene ${s.pos ? s.pos.y : '?'}`, build: 'Haus bauen', smelt: 'Sachen im Ofen schmelzen', hunt: 'Tiere jagen', craft: 'Werkzeug craften', enchant: 'Verzaubern', portal: 'Netherportal bauen', nether: 'Nether-Expedition', explore: 'Gegend erkunden', combat: 'Kämpfen', eat: 'Essen', sleep: 'Schlafen', idle: 'Basis-Alltag', recover: 'Loot zurückholen', offline: 'Neu verbinden', paused: 'Pause' }[act] || 'Überleben'
    return {
      user: v.name || '',
      y: s.pos ? String(s.pos.y).replace('-', 'Minus ') : '?',
      x: s.pos ? s.pos.x : '?',
      z: s.pos ? s.pos.z : '?',
      hp: String(hp).replace('.', ','),
      foodbar: Math.round((s.food ?? 20) / 2),
      threats: s.threats || 0,
      goal: s.goal || short,
      doing,
      activity_short: short,
      mine_reason: mineReason,
      inv_wood: inv.logs ? `${inv.logs} Stämme hab ich schon.` : '',
      shield_part: s.shield ? ' und mein Schild ist fast kaputt' : ' und ich hab nicht mal ein Schild',
      food_part: (s.food ?? 20) < 10 ? 'einen leeren Magen' : 'bin ziemlich angeschlagen',
      mood_extra: inv.diamonds ? `${inv.diamonds} Diamanten in der Tasche, was will man mehr.` : s.base && s.base.done ? 'Das Haus steht, das Leben ist schön.' : inv.iron ? 'Eisen ist am Start, wir kommen voran.' : 'Der Run läuft gerade erst an.',
      dimension_part: s.dimension === 'nether' ? 'Mitten im Nether!' : s.night ? 'Und es ist stockdunkel.' : ''
    }
  }

  emotionForState () {
    const s = this.status()
    if (s.fighting && ((s.health ?? 20) <= 10 || (s.threats || 0) >= 4)) return 'panic'
    if (s.fighting) return 'hype'
    return 'chill'
  }

  // ---------------------------------------------------------------- TikTok: Gifts
  /**
   * @param {{uniqueId: string, nickname?: string}} viewer
   * @param {{id: string, name: string, coins: number}} gift
   * @param {{label: string, kind: 'mob'|'support', spawnText: string, mob?: string, tier: number}} effect
   * @param {number} count Combo-Zähler
   */
  onGift (viewer, gift, effect, count = 1) {
    this.lastExternal = Date.now()
    const m = this.viewer(viewer)
    const before = m.gifts[gift.id] || 0
    m.gifts[gift.id] = before + count
    m.totalGifts += count
    m.coins += (gift.coins || 0) * count
    const n = m.gifts[gift.id]
    const vars = {
      ...this.stateVars(m), gift: gift.name, coins: gift.coins * count, n, count, nth: ord(n, 'r'), nth_n: ord(n, 'n'), spawn: effect.spawnText, mob: mobDe(effect.mob)
    }
    const kind = effect.kind === 'support' ? 'support' : 'mob'
    let text
    let emotion = 'hype'
    if (effect.tier >= 5) { text = this.line(L.gift_boss, vars); emotion = 'panic' } else if (effect.tier >= 4 && before === 0) { text = this.line(L.gift_big, vars); emotion = 'panic' } else if (count >= 5 && before > 0) text = this.line(L.combo, vars)
    else if (n >= 5) text = this.line(L.gift_many[kind], vars)
    else if (n >= 2) text = this.line(L.gift_repeat[kind], vars)
    else text = this.line(L.gift_first[kind], vars)
    // Kleine Gifts im Dauerfeuer: nicht jedes einzelne kommentieren
    const small = effect.tier <= 1
    if (small && !this.cooldown('gift:' + m.id, n >= 5 ? 6000 : 3500) && n !== 5) return { memory: m, spoken: false }
    this.say(text, { emotion, priority: 3 + Math.min(3, effect.tier), kind: 'gift', ttl: 14000 })
    return { memory: m, spoken: true }
  }

  onFollow (viewer) {
    const m = this.viewer(viewer)
    if (this.cooldown('follow', 8000)) this.say(this.line(L.follow, { user: m.name }), { emotion: 'hype', priority: 2, kind: 'follow' })
  }

  onShare (viewer) {
    const m = this.viewer(viewer)
    if (this.cooldown('share', 20000)) this.say(this.line(L.share, { user: m.name }), { emotion: 'hype', priority: 2, kind: 'share' })
  }

  onLike (viewer, count = 1) {
    this.likeCount += count
    if (this.likeCount >= 150 && this.cooldown('likes', 45000)) { this.likeCount = 0; this.say(this.line(L.like_burst), { emotion: 'hype', priority: 1, kind: 'like' }) }
  }

  // ---------------------------------------------------------------- TikTok: Chat
  parseGoal (text) {
    for (const [id, re] of GOAL_PATTERNS) if (re.test(text)) return id
    return null
  }

  /**
   * Jede gültige Chatnachricht wird verarbeitet (Gedächtnis, Absicht, Ziel) – und beantwortet,
   * sofern der Streamer nicht gerade im Dauerfeuer steckt.
   * @returns {{intent: string, goal?: string, replied: boolean}}
   */
  onChat (viewer, rawText) {
    const text = String(rawText || '').replace(/\s+/g, ' ').trim()
    if (!text || text.length > 300) return { intent: 'invalid', replied: false }
    this.lastExternal = Date.now()
    const m = this.viewer(viewer)
    m.chats++
    const s = this.status()
    const fighting = !!s.fighting
    const vars = this.stateVars(m)
    const emotion = this.emotionForState()
    const reply = (t, o = {}) => {
      if (!t) return false
      const ok = this.say(t, { emotion, priority: o.priority ?? 2, kind: 'chat', ttl: o.ttl ?? 10000 })
      if (ok && !fighting && this.deps.onAddress) this.deps.onAddress()
      return ok
    }
    const lower = text.toLowerCase()

    // 1) Gameplay-Wünsche
    const goal = this.parseGoal(lower)
    if (goal) {
      const res = this.deps.pushGoal(goal, m.name) || { ok: false }
      m.goals++
      if (!res.ok && res.reason === 'offline') reply(this.line(L.goal_offline, vars), { priority: 3 })
      else if (!res.ok && res.reason === 'no_loot') reply(this.line(L.corpse_run_none, vars), { priority: 3 })
      else if (res.already) reply(this.line(L.goal_already, { ...vars, label: res.label }), { priority: 3 })
      else if (res.ok && fighting) reply(this.line(L.goal_busy, vars), { priority: 3 })
      else if (res.ok) reply(this.line(L.goal_ack[goal], vars), { priority: 4, ttl: 15000 })
      return { intent: 'goal', goal, replied: true }
    }
    // 2) Fragen zum Zustand
    let intent = 'generic'
    let out = null
    if (/was (machst|tust|treibst|baust|geht)|was (ist|steht) (dein )?(plan|ziel)|was hast du vor|wo(ran)? arbeitest/i.test(lower)) {
      intent = 'what_doing'
      out = this.line(L.what_doing[s.activity] || L.what_doing.idle, vars)
    } else if (/wie geht('?s| es)|alles (gut|klar|fit)|wie f[üu]hlst|wie l[äa]uft/i.test(lower)) {
      intent = 'how_are_you'
      const pool = fighting ? L.how_are_you.fight : (s.health ?? 20) <= 10 ? L.how_are_you.low : s.night && !(s.base && s.base.done) ? L.how_are_you.night : L.how_are_you.good
      out = this.line(pool, vars)
    } else if (/wo bist|koordinaten|coords|welche ebene|wie tief/i.test(lower)) {
      intent = 'where'; out = this.line(L.where, vars)
    } else if (/wie ?viel(e)? (leben|herzen|hp)|dein(e)? (leben|herzen|hp)/i.test(lower)) {
      intent = 'hp'; out = this.line(L.hp, vars)
    } else if (/bist du (ein(e)? )?(bot|ki|ai|mensch|echt|roboter)|wer bist du|ist das (eine? )?(ki|ai|bot)/i.test(lower)) {
      intent = 'who'; out = this.line(L.who, vars)
    } else if (/^(hi|hey|hallo|moin|servus|na|huhu|guten (tag|abend|morgen)|was geht|yo|hello|sal[üu]|gr[üu](ß|ss) (dich|gott))\b/i.test(lower)) {
      intent = 'greet'
      out = this.line(m.greeted ? L.greet_again : L.greet, vars)
      m.greeted = true
    } else if (/\b(geil|stark|krass|bester?|mega|nice|gut gemacht|gg|liebe? (dich|den stream)|cool|hammer|ehre|respekt|legend\w*)\b/i.test(lower)) {
      intent = 'compliment'; out = this.line(L.compliment, vars)
    } else if (/\b(noob|schlecht|bot ist dumm|dumm|lappen|trash|schwach|opfer|kacke|m[üu]ll)\b/i.test(lower)) {
      intent = 'insult'; out = this.line(L.insult, vars)
    } else if (/\b(haha+|lol|lmao|xd+|😂|🤣)\b|😂|🤣/i.test(lower)) {
      intent = 'laugh'; out = this.line(L.laugh, vars)
    } else out = this.line(fighting ? L.generic.fight : L.generic.calm, vars)

    // Wenn der Chat rast, bekommen einfache Nachrichten nicht jede eine Sprachantwort (verarbeitet sind sie trotzdem)
    const low = intent === 'generic' || intent === 'laugh' || intent === 'greet'
    if (low && (this.queue.length >= 2 || !this.cooldown('chat:low', fighting ? 9000 : 3500))) return { intent, replied: false }
    if (!this.cooldown(`chat:${m.id}:${intent}`, 12000)) return { intent, replied: false }
    return { intent, replied: reply(out, { priority: low ? 1 : 2 }) }
  }

  // ---------------------------------------------------------------- Bot-Ereignisse
  onBotEvent (type, d = {}) {
    const s = this.status()
    const v = this.stateVars()
    const say = (pool, vars, o = {}) => {
      const key = o.key || type
      if (!this.cooldown('ev:' + key, o.cd ?? 25000)) return
      this.say(this.line(pool, { ...v, ...vars }), { emotion: o.emotion || 'chill', priority: o.priority ?? 1, kind: 'event', ttl: o.ttl })
    }
    switch (type) {
      case 'plan':
        if (d.auto && d.steps && d.steps.length) say(L.plan, { goal: d.goal, steps: d.steps.slice(0, 3).join(', dann '), first: d.steps[0] }, { cd: 40000 })
        return
      case 'tree_done': return say(L.tree_done, d, { cd: 45000 })
      case 'craft': return
      case 'station_packed': if (d.kind === 'crafting_table') say(L.station_packed, d, { cd: 120000 }); return
      case 'mine_start': return say(L.mine_start, d, { cd: 60000 })
      case 'ore_found': return say(L.ore_found[d.ore] || L.ore_found.other, d, { key: 'ore:' + d.ore, cd: d.ore === 'diamond' ? 15000 : 50000, emotion: d.ore === 'diamond' ? 'hype' : 'chill', priority: d.ore === 'diamond' ? 3 : 1 })
      case 'vein_done': if (d.count >= 3) say(L.vein_done, d, { cd: 40000 }); return
      case 'lava': return say(L.lava, d, { emotion: 'panic', priority: 4 })
      case 'mine_return': return say(L.mine_return, d, { cd: 60000 })
      case 'hunt_kill': return say(L.hunt_kill, d, { cd: 30000 })
      case 'smelt_start': return say(L.smelt_start, { count: d.count, item_de: itemDe(d.item), fuel_part: d.fuel ? `${d.fuelCount} mal Brennstoff rein, das reicht genau. ` : '' }, { cd: 40000 })
      case 'smelt_done': return say(L.smelt_done, d, { cd: 60000 })
      case 'gear': {
        if (d.items.includes('shield')) return say(L.shield_get, d, { key: 'shield_get', cd: 600000, emotion: 'hype', priority: 2 })
        return say(L.gear, { items: d.items.map(itemDe).join(' und ') }, { cd: 20000, emotion: 'hype', priority: 2 })
      }
      case 'build_site': return say(L.build_site, d, { cd: 300000 })
      case 'build_progress': {
        if (d.stage === this.lastStage || !L.build_progress[d.stage]) return
        this.lastStage = d.stage
        return say(L.build_progress[d.stage], d, { key: 'build:' + d.stage, cd: 120000 })
      }
      case 'build_done': this.lastStage = -1; return say(L.build_done, d, { emotion: 'hype', priority: 3, cd: 600000 })
      case 'build_paused': return say(L.build_paused, { missing: (d.missing || []).map(k => KIND_DE[k] || k).join(' und ') || 'Material' }, { cd: 90000 })
      case 'sleep_start': return say(d.thunder ? L.sleep_thunder : L.sleep_start, d, { key: 'sleep_start', cd: 120000, priority: 3 })
      case 'sleep_failed': return say(L.sleep_failed, d, { cd: 120000 })
      case 'wake': return say(L.wake, d, { cd: 120000 })
      case 'bed_crafted': return say(L.bed_crafted, d, { emotion: 'hype', priority: 2 })
      case 'corpse_run_start': return say(L.corpse_run_start, d, { emotion: 'panic', priority: 6, cd: 3000, ttl: 20000 })
      case 'corpse_run_done': return say(d.ok ? L.corpse_run_done.ok : L.corpse_run_done.fail, d, { emotion: d.ok ? 'hype' : 'chill', priority: 4, cd: 3000, ttl: 20000 })
      case 'corpse_run_none': return say(L.corpse_run_none, d, { cd: 15000 })
      case 'camera': if (d.mode === 'third' && d.auto) say(L.camera.third, d, { cd: 180000 }); return
      case 'sleep': return
      case 'enchanted': return say(L.enchanted, d, { emotion: 'hype', priority: 4, cd: 3000, ttl: 20000 })
      case 'enchant_table': return say(L.enchant_table, d, { emotion: 'hype', priority: 2 })
      case 'obsidian': if (d.count % 3 === 1) say(L.obsidian, d, { cd: 30000 }); return
      case 'portal_lit': return say(L.portal_lit, d, { emotion: 'hype', priority: 4 })
      case 'nether_enter': return say(d.gold ? L.nether_enter.gold : L.nether_enter.nogold, d, { priority: 3 })
      case 'nether_arrived': return say(L.nether_arrived, d, { emotion: 'hype', priority: 3 })
      case 'fortress_found': return say(L.fortress_found, d, { emotion: 'hype', priority: 3, cd: 300000 })
      case 'nether_home': return say(L.nether_home, d, { emotion: 'hype', priority: 3 })
      case 'nether_retreat': return say(L.nether_retreat, d, { priority: 2 })
      case 'combat_start': {
        const pool = d.donor ? L.combat_start.gift : d.count >= 3 ? L.combat_start.many : L.combat_start.one
        return say(pool, { count: d.count, mob: mobDe(d.mobs && d.mobs[0]), donor: d.donor ? this.speakable(d.donor) : '' }, { emotion: d.count >= 3 ? 'panic' : 'hype', priority: 2, key: 'combat_start', cd: 25000 })
      }
      case 'kill':
        if (d.donor) return say(L.kill_gift, { mob: mobDe(d.mob), donor: this.speakable(d.donor) }, { emotion: 'hype', priority: 2, key: 'kill:' + d.donor, cd: 12000 })
        return say(L.kill, d, { emotion: 'hype', cd: 30000 })
      case 'swing': if (d.crit && d.kind === 'attack') say(L.crit, d, { key: 'crit', cd: 90000, emotion: 'hype' }); return
      case 'shield': return say(L.shield[d.kind] || L.shield.arrow, d, { emotion: 'panic', priority: 4, key: 'shield:' + d.kind, cd: 25000 })
      case 'kite': return say(L.kite, d, { emotion: 'panic', priority: 3 })
      case 'low_hp': return say(L.low_hp, d, { emotion: 'panic', priority: 4, key: 'low_hp', cd: 25000 })
      case 'critical_hp': return say(L.critical_hp, d, { emotion: 'panic', priority: 4, key: 'low_hp', cd: 25000 })
      case 'ate': return d.underPressure ? say(L.ate_pressure, d, { emotion: 'hype', priority: 2 }) : say(L.ate, { item_de: itemDe(d.item) }, { cd: 90000 })
      case 'death': this.queue = []; return say(L.death, d, { emotion: 'panic', priority: 6, cd: 3000, ttl: 20000 })
      case 'stuck': return say(d.depth > 1 ? L.stuck.hole : L.stuck.other, d, { cd: 30000, emotion: 'hype' })
      case 'night': return say(L.night, d, { cd: 300000 })
      case 'day': return say(L.day, d, { cd: 300000 })
      case 'pickup': if (d.item === 'diamond') say(L.pickup_diamond, d, { cd: 60000, emotion: 'hype' }); return
      case 'goal_done': if (d.goal && !d.goal.auto) say(L.goal_done, { label: d.goal.label, by_part: d.goal.by ? `, danke für die Idee, ${d.goal.by}` : '' }, { key: 'goal_done:' + d.goal.id, cd: 5000, emotion: 'hype', priority: 2 }); return
      case 'goal_failed': if (d.goal && !d.goal.auto) say(L.goal_failed, { label: d.goal.label }, { cd: 20000 }); return
      case 'warn': if (d.code === 'no_op') say(L.no_op, d, { cd: 600000 }); return
      default:
        void s
    }
  }

  // ---------------------------------------------------------------- Selbstbewusste Hilferufe
  /**
   * Prüft die echte Lage (Gegnerzahl, Waffe, Leben, Hunger) und nennt ein konkretes Gift aus der
   * LIVE-Konfiguration, das jetzt helfen würde. Nichts ist fest verdrahtet: Name und Wirkung
   * kommen aus getSupportGift().
   */
  tacticalCallout () {
    const s = this.status()
    if (!s.connected || !this.enabled) return false
    const inv = s.inv || {}
    const gift = kinds => (this.deps.getSupportGift ? this.deps.getSupportGift(kinds) : null)
    const v = this.stateVars()
    const hp = s.health ?? 20
    const mobsDe = { zombie: 'Zombies', skeleton: 'Skelette', creeper: 'Creeper', spider: 'Spinnen', vindicator: 'Diener', piglin_brute: 'Piglin-Barbaren', husk: 'Wüstenzombies' }
    if (s.fighting && (s.threats || 0) >= 3 && (inv.swordTier ?? 0) <= 2) {
      if (!this.cooldown('ev:callout', 25000) || !this.cooldown('ev:callout_weapon', 60000)) return false
      const g = gift(['drop_weapon', 'drop_diamond_gear', 'drop_armor'])
      const missing = Math.max(0, 2 - (inv.rawIronTotal || 0))
      const weapon = ['meine bloßen Fäuste', 'mein Holzschwert', 'mein Steinschwert'][inv.swordTier ?? 0]
      const vars = { ...v, mobs: mobsDe[(s.threatNames || [])[0]] || 'Gegner', weapon, weapon_dat: ['bloßen Fäusten', 'einem Holzschwert', 'einem Steinschwert'][inv.swordTier ?? 0], iron_part: missing > 0 ? `Mir fehlen noch ${missing} Eisen für ein Eisenschwert – oder ` : 'Ich brauch dringend was Besseres – ', gift: g ? g.name : '', gear: g ? g.gear : '' }
      return this.say(this.line(g ? L.callout_weapon : L.callout_weapon_nogift, vars), { emotion: 'panic', priority: 4, kind: 'callout' })
    }
    if (hp <= 8 && !(inv.food > 0)) {
      const g = gift(['heal', 'support_apple', 'support_random'])
      if (!g || !this.cooldown('ev:callout', 25000) || !this.cooldown('ev:callout_heal', 60000)) return false
      return this.say(this.line(L.callout_heal, { ...v, gift: g.name }), { emotion: 'panic', priority: 4, kind: 'callout' })
    }
    if ((s.food ?? 20) <= 6 && !(inv.food > 0) && !s.fighting) {
      const g = gift(['drop_food', 'heal', 'support_random'])
      if (!g || !this.cooldown('ev:callout', 25000) || !this.cooldown('ev:callout_food', 90000)) return false
      return this.say(this.line(L.callout_food, { ...v, gift: g.name }), { emotion: 'chill', priority: 2, kind: 'callout' })
    }
    return false
  }

  onLiveConnected () { this.lastExternal = Date.now(); this.say(this.line(L.live_connected), { emotion: 'hype', priority: 5, kind: 'system', ttl: 20000 }) }

  onGiftDiscovered (viewer, gift) {
    if (!this.cooldown('ev:discovered', 20000)) return
    this.say(this.line(L.gift_discovered, { user: this.viewer(viewer).name, gift: gift.name }), { emotion: 'hype', priority: 2, kind: 'gift' })
  }

  // ---------------------------------------------------------------- Idle-Monologe
  _maybeMonologue (now) {
    if (now - this.lastExternal < 12000 || now - this.lastSpoke < 9000) return
    const s = this.status()
    if (!s.connected || s.fighting) return
    if (!this.cooldown('monologue', 14000)) return
    const pool = Math.random() < 0.25 ? L.idle.generic : (L.idle[s.activity] || L.idle.generic)
    this.say(this.line(pool, this.stateVars()), { emotion: 'chill', priority: 0, kind: 'monologue', ttl: 6000 })
  }

  /** Operator-Sprachzeile (Dashboard/Handy). */
  sayCustom (text, emotion = 'chill') { return this.say(String(text).slice(0, 400), { emotion, priority: 5, kind: 'operator', ttl: 30000 }) }

  memorySnapshot (limit = 12) {
    return [...this.viewerMemoryMap.values()].sort((a, b) => b.coins - a.coins || b.chats - a.chats).slice(0, limit)
      .map(m => ({ name: m.name, gifts: m.totalGifts, coins: m.coins, chats: m.chats }))
  }
}

module.exports = { StreamerBrain, GOAL_PATTERNS, mobDe }
