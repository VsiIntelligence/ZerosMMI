/**
 * Extra pronunciations (ARPAbet, stress digits on vowels) for common lyric vocabulary, contractions without their
 * apostrophe, and words the spelling rules get wrong. Used whenever the model does not supply its own `ph` line.
 */
export const EXTRA_DICT: Record<string, string> = {
  /* contractions (apostrophe removed) */
  cant: "K AE1 N T", dont: "D OW1 N T", wont: "W OW1 N T", im: "AY1 M", ill: "AY1 L", ive: "AY1 V", id: "AY1 D", its: "IH1 T S", youre: "Y UH1 R", theyre: "DH EH1 R", thats: "DH AE1 T S", theres: "DH EH1 R Z",
  whats: "W AH1 T S", lets: "L EH1 T S", aint: "EY1 N T", isnt: "IH1 Z AH0 N T", wasnt: "W AH1 Z AH0 N T", couldnt: "K UH1 D AH0 N T", wouldnt: "W UH1 D AH0 N T", shouldnt: "SH UH1 D AH0 N T",
  didnt: "D IH1 D AH0 N T", doesnt: "D AH1 Z AH0 N T", havent: "HH AE1 V AH0 N T", hasnt: "HH AE1 Z AH0 N T", arent: "AA1 R N T", werent: "W ER1 N T", hadnt: "HH AE1 D AH0 N T", youve: "Y UW1 V",
  weve: "W IY1 V", theyve: "DH EY1 V", youll: "Y UW1 L", hes: "HH IY1 Z", shes: "SH IY1 Z", heres: "HH IH1 R Z", whos: "HH UW1 Z", cuz: "K AH1 Z", til: "T IH1 L", ya: "Y AA1", em: "AH1 M",
  outta: "AW1 T AX", kinda: "K AY1 N D AX", sorta: "S AO1 R T AX", lemme: "L EH1 M IY0", gimme: "G IH1 M IY0", dunno: "D AH0 N OW1",
  /* pronouns, connectors, everyday words */
  everything: "EH1 V R IY0 TH IH2 NG", anything: "EH1 N IY0 TH IH2 NG", something: "S AH1 M TH IH0 NG", nothing: "N AH1 TH IH0 NG", everyone: "EH1 V R IY0 W AH2 N", everybody: "EH1 V R IY0 B AA2 D IY0",
  somebody: "S AH1 M B AA2 D IY0", nobody: "N OW1 B AA2 D IY0", someone: "S AH1 M W AH2 N", anyone: "EH1 N IY0 W AH2 N", nowhere: "N OW1 W EH2 R", somewhere: "S AH1 M W EH2 R", everywhere: "EH1 V R IY0 W EH2 R",
  anywhere: "EH1 N IY0 W EH2 R", today: "T AH0 D EY1", tomorrow: "T AH0 M AA1 R OW0", yesterday: "Y EH1 S T ER0 D EY2", maybe: "M EY1 B IY0", another: "AH0 N AH1 DH ER0", because: "B IH0 K AO1 Z",
  before: "B IH0 F AO1 R", after: "AE1 F T ER0", around: "ER0 AW1 N D", against: "AH0 G EH1 N S T", across: "AH0 K R AO1 S", between: "B IH0 T W IY1 N", beyond: "B IY0 AA1 N D", inside: "IH0 N S AY1 D",
  outside: "AW1 T S AY2 D", without: "W IH0 DH AW1 T", within: "W IH0 DH IH1 N", until: "AH0 N T IH1 L", while: "W AY1 L", still: "S T IH1 L", just: "JH AH1 S T", only: "OW1 N L IY0", even: "IY1 V AH0 N",
  sometimes: "S AH1 M T AY2 M Z", anymore: "EH2 N IY0 M AO1 R", our: "AW1 ER0", hour: "AW1 ER0", power: "P AW1 ER0", flower: "F L AW1 ER0", flowers: "F L AW1 ER0 Z", tower: "T AW1 ER0", shower: "SH AW1 ER0",
  tired: "T AY1 ER0 D", wired: "W AY1 ER0 D", higher: "HH AY1 ER0", liar: "L AY1 ER0", desire: "D IH0 Z AY1 ER0", fire2: "F AY1 ER0", wildfire: "W AY1 L D F AY2 ER0",
  /* feelings and abstractions */
  lonely: "L OW1 N L IY0", rhythm: "R IH1 DH AH0 M", rhythms: "R IH1 DH AH0 M Z", memory: "M EH1 M ER0 IY0", memories: "M EH1 M ER0 IY0 Z", heaven: "HH EH1 V AH0 N", angel: "EY1 N JH AH0 L", angels: "EY1 N JH AH0 L Z",
  broken: "B R OW1 K AH0 N", empty: "EH1 M P T IY0", sorrow: "S AA1 R OW0", tears: "T IH1 R Z", smile: "S M AY1 L", laughter: "L AE1 F T ER0", happy: "HH AE1 P IY0", crazy: "K R EY1 Z IY0", lovely: "L AH1 V L IY0",
  promise: "P R AA1 M AH0 S", believe: "B IH0 L IY1 V", remember: "R IH0 M EH1 M B ER0", forget: "F ER0 G EH1 T", forgive: "F ER0 G IH1 V", imagine: "IH0 M AE1 JH AH0 N", wonder: "W AH1 N D ER0",
  courage: "K ER1 IH0 JH", freedom: "F R IY1 D AH0 M", gravity: "G R AE1 V AH0 T IY0", universe: "Y UW1 N AH0 V ER2 S", paradise: "P EH1 R AH0 D AY2 S", melody: "M EH1 L AH0 D IY0", harmony: "HH AA1 R M AH0 N IY0",
  symphony: "S IH1 M F AH0 N IY0", lullaby: "L AH1 L AH0 B AY2", butterfly: "B AH1 T ER0 F L AY2", heartbeat: "HH AA1 R T B IY2 T", heartbreak: "HH AA1 R T B R EY2 K", golden: "G OW1 L D AH0 N",
  burning: "B ER1 N IH0 NG", falling: "F AO1 L IH0 NG", flying: "F L AY1 IH0 NG", dancing: "D AE1 N S IH0 NG", dreaming: "D R IY1 M IH0 NG", running: "R AH1 N IH0 NG", crying: "K R AY1 IH0 NG", trying: "T R AY1 IH0 NG",
  dying: "D AY1 IH0 NG", loving: "L AH1 V IH0 NG", waiting: "W EY1 T IH0 NG", shining: "SH AY1 N IH0 NG", breaking: "B R EY1 K IH0 NG", chasing: "CH EY1 S IH0 NG", driving: "D R AY1 V IH0 NG", singing: "S IH1 NG IH0 NG",
  /* nature and place */
  thunder: "TH AH1 N D ER0", lightning: "L AY1 T N IH0 NG", storm: "S T AO1 R M", wind: "W IH1 N D", breeze: "B R IY1 Z", cloud: "K L AW1 D", clouds: "K L AW1 D Z", mountain: "M AW1 N T AH0 N", mountains: "M AW1 N T AH0 N Z",
  valley: "V AE1 L IY0", forest: "F AO1 R AH0 S T", water: "W AO1 T ER0", waves: "W EY1 V Z", shore: "SH AO1 R", sand: "S AE1 N D", desert: "D EH1 Z ER0 T", garden: "G AA1 R D AH0 N", rose: "R OW1 Z", roses: "R OW1 Z IH0 Z",
  petals: "P EH1 T AH0 L Z", autumn: "AO1 T AH0 M", winter: "W IH1 N T ER0", summer: "S AH1 M ER0", spring: "S P R IH1 NG", sunrise: "S AH1 N R AY2 Z", sunset: "S AH1 N S EH2 T", moonlight: "M UW1 N L AY2 T",
  daylight: "D EY1 L AY2 T", midnight: "M IH1 D N AY2 T", morning: "M AO1 R N IH0 NG", evening: "IY1 V N IH0 NG", shadow: "SH AE1 D OW0", shadows: "SH AE1 D OW0 Z", silence: "S AY1 L AH0 N S", echo: "EH1 K OW0",
  crystal: "K R IH1 S T AH0 L", diamond: "D AY1 M AH0 N D", diamonds: "D AY1 M AH0 N D Z", thousand: "TH AW1 Z AH0 N D", million: "M IH1 L Y AH0 N", hundred: "HH AH1 N D R AH0 D", highway: "HH AY1 W EY2",
  windshield: "W IH1 N D SH IY2 L D", static: "S T AE1 T IH0 K", margin: "M AA1 R JH AH0 N", borrowed: "B AA1 R OW0 D", whispered: "W IH1 S P ER0 D", whisper: "W IH1 S P ER0", neon: "N IY1 AA2 N", ghost: "G OW1 S T",
  glass: "G L AE1 S", bridge: "B R IH1 JH", carry: "K AE1 R IY0", prayer: "P R EH1 R", stranger: "S T R EY1 N JH ER0", strangers: "S T R EY1 N JH ER0 Z", coffee: "K AO1 F IY0", paper: "P EY1 P ER0", letter: "L EH1 T ER0",
  folded: "F OW1 L D IH0 D", spark: "S P AA1 R K", rope: "R OW1 P", slam: "S L AE1 M", door: "D AO1 R", window: "W IH1 N D OW0", street: "S T R IY1 T", streets: "S T R IY1 T S", skyline: "S K AY1 L AY2 N", engine: "EH1 N JH AH0 N",
  heater: "HH IY1 T ER0", radio: "R EY1 D IY0 OW2", chocolate: "CH AO1 K L AH0 T", interesting: "IH1 N T R AH0 S T IH0 NG", electric: "IH0 L EH1 K T R IH0 K", counted: "K AW1 N T IH0 D", streetlights: "S T R IY1 T L AY2 T S",
  /* body, colour, number */
  lips: "L IH1 P S", skin: "S K IH1 N", bones: "B OW1 N Z", blood: "B L AH1 D", breath: "B R EH1 TH", breathe: "B R IY1 DH", fingers: "F IH1 NG G ER0 Z", arms: "AA1 R M Z",
  red: "R EH1 D", blue: "B L UW1", green: "G R IY1 N", yellow: "Y EH1 L OW0", purple: "P ER1 P AH0 L", silver: "S IH1 L V ER0", black: "B L AE1 K", white: "W AY1 T",
  three: "TH R IY1", four: "F AO1 R", five: "F AY1 V", six: "S IH1 K S", seven: "S EH1 V AH0 N", eight: "EY1 T", nine: "N AY1 N", ten: "T EH1 N",
  /* verbs and sounds that trip the spelling rules */
  keep: "K IY1 P", leave: "L IY1 V", lose: "L UW1 Z", lost: "L AO1 S T", find: "F AY1 N D", found: "F AW1 N D", need: "N IY1 D", want: "W AA1 N T", take: "T EY1 K", give: "G IH1 V", make: "M EY1 K", made: "M EY1 D",
  turn: "T ER1 N", burn: "B ER1 N", learn: "L ER1 N", earth: "ER1 TH", worth: "W ER1 TH", word: "W ER1 D", words: "W ER1 D Z", hear: "HH IH1 R", here: "HH IH1 R", near: "N IH1 R", fear: "F IH1 R", clear: "K L IH1 R",
  year: "Y IH1 R", years: "Y IH1 R Z", hurt: "HH ER1 T", heard: "HH ER1 D", girl: "G ER1 L", boy: "B OY1", lover: "L AH1 V ER0", kiss: "K IH1 S", touch: "T AH1 CH", embrace: "IH0 M B R EY1 S", money: "M AH1 N IY0", party: "P AA1 R T IY0",
  hope: "HH OW1 P", road: "R OW1 D", roads: "R OW1 D Z", long: "L AO1 NG", strong: "S T R AO1 NG", wrong: "R AO1 NG", along: "AH0 L AO1 NG", belong: "B IH0 L AO1 NG", close: "K L OW1 Z", loud: "L AW1 D", louder: "L AW1 D ER0",
  sweet: "S W IY1 T", sleep: "S L IY1 P", slow: "S L OW1", fast: "F AE1 S T", deep: "D IY1 P", wide: "W AY1 D", wake: "W EY1 K", break: "B R EY1 K", shake: "SH EY1 K", chase: "CH EY1 S", grace: "G R EY1 S", place: "P L EY1 S",
  space: "S P EY1 S", brave: "B R EY1 V", save: "S EY1 V", wave: "W EY1 V", crown: "K R AW1 N", town: "T AW1 N", down: "D AW1 N", sound: "S AW1 N D", ground: "G R AW1 N D", round: "R AW1 N D", cloudy: "K L AW1 D IY0",
};
