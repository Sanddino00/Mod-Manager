import type { BrowseGameData, CategoryKey, GameDefinition, GameKey } from "../types";

export const GAME_ORDER: GameKey[] = ["gi", "hsr", "wuwa", "zzz", "end"];

export const CATEGORY_ORDER: CategoryKey[] = [
  "characters",
  "weapons",
  "ui",
  "objects",
  "npcs",
  "buffervalues",
];

export const GAMES: Record<GameKey, GameDefinition> = {
  gi: {
    id: "gi",
    name: "Genshin Impact",
    shortLabel: "GI",
    accent: "#69d4f6",
    description: "Character-heavy library with the broadest existing category surface and legacy data set.",
    categories: CATEGORY_ORDER,
  },
  hsr: {
    id: "hsr",
    name: "Honkai Star Rail",
    shortLabel: "HSR",
    accent: "#ffd166",
    description: "Parallel structure to GI, with shared browse and fix workflows but its own mod root.",
    categories: CATEGORY_ORDER,
  },
  wuwa: {
    id: "wuwa",
    name: "Wuthering Waves",
    shortLabel: "WuWa",
    accent: "#7ef0b8",
    description: "Smaller browse taxonomy, but it still uses the same manager conventions and script tooling.",
    categories: CATEGORY_ORDER,
  },
  zzz: {
    id: "zzz",
    name: "Zenless Zone Zero",
    shortLabel: "ZZZ",
    accent: "#f08a7e",
    description: "Shared lifecycle with GI and HSR while keeping separate browse metadata and fix scripts.",
    categories: CATEGORY_ORDER,
  },
  end: {
    id: "end",
    name: "Endfield",
    shortLabel: "END",
    accent: "#d7b4ff",
    description: "Newest target game in the matrix, designed to slot into the same data-driven configuration.",
    categories: CATEGORY_ORDER,
  },
};

export const GAMEBANANA_URLS: Record<GameKey, string> = {
  gi: "https://gamebanana.com/games/8552",
  hsr: "https://gamebanana.com/games/18366",
  wuwa: "https://gamebanana.com/games/20357",
  zzz: "https://gamebanana.com/games/19567",
  end: "https://gamebanana.com/games/21842",
};

export const ARCA_GAMES = ["gi", "hsr", "wuwa", "zzz"] as const;

export type ArcaGameKey = (typeof ARCA_GAMES)[number];

export const ARCA_URLS: Record<ArcaGameKey, { normal: string; r18: string }> = {
  gi: {
    normal: "https://arca.live/b/genshinskinmode?category=%EB%AA%A8%EB%93%9C%EA%B3%B5%EC%9C%A0",
    r18: "https://arca.live/b/genshinskinmode?category=%EC%A7%88%EB%AC%B8(%EB%AA%A8%EB%93%9C%EC%A0%9C%EC%9E%91)",
  },
  hsr: {
    normal: "https://arca.live/b/genshinskinmode?category=%EB%B6%95%EC%8A%A4%EB%AA%A8%EB%93%9C",
    r18: "https://arca.live/b/genshinskinmode?category=%EB%B6%95%EC%8A%A4%EB%AA%A8%EB%93%9C%F0%9F%94%9E",
  },
  wuwa: {
    normal: "https://arca.live/b/thingzyoa?category=WWMI",
    r18: "https://arca.live/b/thingzyoa?category=Wwmi%EC%95%BC",
  },
  zzz: {
    normal: "https://arca.live/b/genshinskinmode?category=%EC%A0%A0%EC%A1%B4%EC%A0%9C",
    r18: "https://arca.live/b/genshinskinmode?category=%EC%A0%A0%EC%A1%B4%EC%A0%9C%F0%9F%94%9E",
  },
};

export const RABBITFX_URLS: Partial<Record<GameKey, string>> = {
  wuwa: "https://gamebanana.com/mods/527815",
  hsr: "https://gamebanana.com/mods/608041",
  zzz: "https://gamebanana.com/mods/531649",
  end: "https://gamebanana.com/mods/651557",
};

export const BROWSE_GAME_DATA: Record<GameKey, BrowseGameData> = {
  gi: {
    gameId: "8552",
    types: [
      { name: "Characters", id: 18140 },
      { name: "Weapons", id: 18137 },
      { name: "Other", id: 12526 },
      { name: "UI", id: 22474 },
      { name: "Objects", id: 18310 },
      { name: "Entity", id: 22725 },
      { name: "Gadget", id: 23574 },
      { name: "Waverider", id: 24279 },
    ],
  },
  hsr: {
    gameId: "18366",
    types: [
      { name: "Characters", id: 22832 },
      { name: "Weapons", id: 22833 },
      { name: "UI", id: 22830 },
      { name: "Other", id: 22628 },
      { name: "Objects", id: 22829 },
      { name: "Entity", id: 23974 },
    ],
  },
  wuwa: {
    gameId: "20357",
    types: [
      { name: "Skins", id: 29524 },
      { name: "UI", id: 29496 },
      { name: "Other", id: 29493 },
    ],
  },
  zzz: {
    gameId: "19567",
    types: [
      { name: "Characters", id: 30305 },
      { name: "Bangboo", id: 30702 },
      { name: "Other", id: 29874 },
      { name: "UI", id: 30395 },
    ],
  },
  end: {
    gameId: "21842",
    types: [
      { name: "Operators", id: 42770 },
      { name: "Weapons", id: 42772 },
      { name: "UI", id: 42706 },
      { name: "Other", id: 42780 },
    ],
  },
};

export const GITHUB_RELEASES_API = "https://api.github.com/repos/Sanddino00/Mod-Manager/releases/latest";