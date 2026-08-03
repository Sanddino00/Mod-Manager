import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader.js";
import { decodeImage, parseDDSHeader } from "dds-ktx-parser";

type Props = {
  modelPath: string;
  onModelPathChange: (next: string) => void;
  toAssetSrc: (path: string) => string;
};

type PreviewBuildResult = {
  model_path: string | null;
  diffuse_texture_path: string | null;
  texture_bindings: Record<string, string>;
  metadata_path: string;
  recipe_path: string;
  toggle_count: number;
  message: string;
};

type PreviewToggleEntry = {
  name: string;
  key: string;
  back?: string | null;
  vars?: Array<{
    name: string;
    values: string[];
  }>;
};

type PreviewMetadata = {
  mod_path?: string | null;
  diffuse_texture_path?: string | null;
  texture_bindings?: Record<string, string>;
  toggles?: PreviewToggleEntry[];
};

type MeshRow = {
  id: string;
  name: string;
  material: string;
  visible: boolean;
  manual: boolean;
};

function parseToggleStates(toggle: PreviewToggleEntry): string[] {
  const vars = Array.isArray(toggle.vars) ? toggle.vars : [];
  const maxCount = vars.reduce((max, item) => Math.max(max, item.values?.length ?? 0), 0);

  if (maxCount > 0) {
    const labels: string[] = [];
    for (let index = 0; index < maxCount; index += 1) {
      const fragments = vars
        .map((item) => {
          const value = item.values?.[index] ?? item.values?.[item.values.length - 1] ?? "?";
          return `${item.name}=${value}`;
        })
        .slice(0, 2);
      labels.push(`state ${index + 1}${fragments.length > 0 ? ` (${fragments.join(", ")})` : ""}`);
    }
    return labels;
  }

  return ["Off", "On"];
}

function toggleSearchTerms(toggle: PreviewToggleEntry): string[] {
  const fromName = toggle.name
    .toLowerCase()
    .replace(/^key\s+/, "")
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  const fromVars = (toggle.vars ?? [])
    .map((item) => item.name.replace(/^\$+/, "").toLowerCase())
    .flatMap((value) => value.split(/[^a-z0-9]+/))
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

  return Array.from(new Set([...fromName, ...fromVars]));
}

function toggleKeyName(toggleName: string): string {
  return toggleName.trim().toLowerCase();
}

function applyTokenAliases(token: string): string[] {
  const aliases: Record<string, string[]> = {
    panties: ["panty", "underwear"],
    vagina: ["crotch", "pubic"],
    pubic: ["pubis", "groin"],
    dress: ["skirt", "cloth"],
    hair: ["bang", "bangs", "hairpiece"],
    veil: ["mask"],
    makeup: ["face"],
    eyes: ["eye", "head"],
  };

  return [token, ...(aliases[token] ?? [])];
}

function normalizedTokens(toggle: PreviewToggleEntry): string[] {
  const terms = toggleSearchTerms(toggle);
  const expanded = terms.flatMap((token) => applyTokenAliases(token));
  return Array.from(new Set(expanded));
}

function toggleDisplayName(toggleName: string): string {
  return toggleName.replace(/^Key\s+/i, "");
}

function isTokenMatch(label: string, token: string): boolean {
  if (token.length < 3) {
    return false;
  }

  return label.includes(token);
}

function isNumericToken(value: string): boolean {
  return /^-?\d+$/.test(value.trim());
}

function extractVariantMarker(value: string): { groupKey: string; variant: string } | null {
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/^(.*)_([0-9]+)(_.+)?$/);
  if (!match) {
    return null;
  }

  const prefix = (match[1] ?? "").trim();
  const variant = (match[2] ?? "").trim();
  const suffix = (match[3] ?? "").trim();
  if (!prefix || !variant) {
    return null;
  }

  return {
    groupKey: `${prefix}${suffix}`,
    variant,
  };
}

export function ModelPreviewTab({ modelPath, onModelPathChange, toAssetSrc }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dumpPath, setDumpPath] = useState("");
  const [modPath, setModPath] = useState("");
  const [outputPath, setOutputPath] = useState("");
  const [buildBusy, setBuildBusy] = useState(false);
  const [buildMsg, setBuildMsg] = useState<string | null>(null);
  const [previewModPath, setPreviewModPath] = useState<string | null>(null);
  const [activeFirstIndices, setActiveFirstIndices] = useState<number[] | null>(null);
  const [autoTexturePath, setAutoTexturePath] = useState<string | null>(null);
  const [textureBindings, setTextureBindings] = useState<Record<string, string>>({});
  const [previewToggles, setPreviewToggles] = useState<PreviewToggleEntry[]>([]);
  const [toggleStatesByName, setToggleStatesByName] = useState<Record<string, string[]>>({});
  const [toggleIndexByName, setToggleIndexByName] = useState<Record<string, number>>({});
  const [meshRows, setMeshRows] = useState<MeshRow[]>([]);
  const [manualMeshVisibility, setManualMeshVisibility] = useState<Record<string, boolean>>({});
  const [showGrid, setShowGrid] = useState(true);
  const [wireframeEnabled, setWireframeEnabled] = useState(false);
  const activeModelRef = useRef<THREE.Object3D | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const meshesRef = useRef<THREE.Mesh[]>([]);
  const meshOwnerByIdRef = useRef<Map<string, string>>(new Map());
  const meshVariantGroupsRef = useRef<Map<string, Map<string, THREE.Mesh[]>>>(new Map());
  const autoTexturePathRef = useRef<string | null>(null);
  const textureBindingsRef = useRef<Record<string, string>>({});
  const texturePromiseCacheRef = useRef<Map<string, Promise<THREE.Texture>>>(new Map());
  const textureApplyVersionRef = useRef(0);

  const meshMaterialName = (mesh: THREE.Mesh): string => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const names = materials
      .map((entry) => (entry && typeof entry.name === "string" ? entry.name.trim() : ""))
      .filter(Boolean);
    return names.length > 0 ? names.join(", ") : "(no material name)";
  };

  const meshPrimaryMaterialName = (mesh: THREE.Mesh): string => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const first = materials.find(
      (entry) => entry && typeof entry.name === "string" && entry.name.trim().length > 0,
    );
    return (first?.name ?? "").trim().toLowerCase();
  };

  const meshFirstIndexMarker = (mesh: THREE.Mesh): number | null => {
    const material = meshPrimaryMaterialName(mesh);
    const match = material.match(/(?:^|_)fi(\d+)(?:_|$)/);
    if (!match) {
      return null;
    }

    const value = Number.parseInt(match[1], 10);
    return Number.isFinite(value) ? value : null;
  };

  const meshLabel = (mesh: THREE.Mesh): string => {
    const name = (mesh.name || "").trim();
    return name.length > 0 ? name : `mesh-${mesh.uuid.slice(0, 8)}`;
  };

  const meshSearchLabel = (mesh: THREE.Mesh): string =>
    `${mesh.name || ""} ${meshMaterialName(mesh)}`.toLowerCase();

  const computeToggleMatchScore = (toggle: PreviewToggleEntry, mesh: THREE.Mesh): number => {
    const tokens = normalizedTokens(toggle);
    if (tokens.length === 0) {
      return 0;
    }

    const label = meshSearchLabel(mesh);
    let score = 0;
    for (const token of tokens) {
      if (!isTokenMatch(label, token)) {
        continue;
      }

      // Favor specific token matches and avoid broad aliases stealing ownership.
      score += token.length;
    }

    return score;
  };

  const findMatches = (toggle: PreviewToggleEntry, meshes: THREE.Mesh[]): THREE.Mesh[] => {
    const tokens = normalizedTokens(toggle);
    if (tokens.length === 0) {
      return [];
    }

    return meshes.filter((mesh) => {
      const label = meshSearchLabel(mesh);
      return tokens.some((token) => isTokenMatch(label, token));
    });
  };

  const refreshMeshRows = () => {
    const rows = meshesRef.current
      .map((mesh) => ({
        id: mesh.uuid,
        name: meshLabel(mesh),
        material: meshMaterialName(mesh),
        visible: mesh.visible,
        manual: Object.prototype.hasOwnProperty.call(manualMeshVisibility, mesh.uuid),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    setMeshRows(rows);
  };

  const applyWireframeToModel = (enabled: boolean) => {
    for (const mesh of meshesRef.current) {
      const entries = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of entries) {
        const candidate = material as THREE.Material & { wireframe?: boolean };
        if (typeof candidate.wireframe !== "boolean") {
          continue;
        }
        candidate.wireframe = enabled;
        candidate.needsUpdate = true;
      }
    }
  };

  const rebuildMeshOwners = () => {
    const ownerById = new Map<string, string>();
    const meshes = meshesRef.current;

    for (const mesh of meshes) {
      let bestOwner: string | null = null;
      let bestScore = 0;

      for (const toggle of previewToggles) {
        const score = computeToggleMatchScore(toggle, mesh);
        if (score <= bestScore) {
          continue;
        }

        bestScore = score;
        bestOwner = toggleKeyName(toggle.name);
      }

      if (bestOwner) {
        ownerById.set(mesh.uuid, bestOwner);
      }
    }

    // If a toggle matched no mesh, keep fallback broad matching for that toggle only.
    for (const toggle of previewToggles) {
      const keyName = toggleKeyName(toggle.name);
      const alreadyHasOwner = Array.from(ownerById.values()).some((owner) => owner === keyName);
      if (alreadyHasOwner) {
        continue;
      }

      for (const mesh of findMatches(toggle, meshes)) {
        if (!ownerById.has(mesh.uuid)) {
          ownerById.set(mesh.uuid, keyName);
        }
      }
    }

    meshOwnerByIdRef.current = ownerById;
  };

  const rebuildVariantGroups = () => {
    const groups = new Map<string, Map<string, THREE.Mesh[]>>();

    for (const mesh of meshesRef.current) {
      const marker = extractVariantMarker(meshPrimaryMaterialName(mesh));
      if (!marker) {
        continue;
      }

      const perVariant = groups.get(marker.groupKey) ?? new Map<string, THREE.Mesh[]>();
      const bucket = perVariant.get(marker.variant) ?? [];
      bucket.push(mesh);
      perVariant.set(marker.variant, bucket);
      groups.set(marker.groupKey, perVariant);
    }

    for (const [groupKey, variants] of groups) {
      if (variants.size < 2) {
        groups.delete(groupKey);
      }
    }

    meshVariantGroupsRef.current = groups;
  };

  const applyVariantToggleVisibility = (
    toggle: PreviewToggleEntry,
    stateIndex: number,
    visibilityByMeshId: Map<string, boolean>,
    matchedMeshes: THREE.Mesh[],
  ): boolean => {
    const vars = Array.isArray(toggle.vars) ? toggle.vars : [];
    let applied = false;
    const candidateGroupKeys = new Set<string>();

    for (const mesh of matchedMeshes) {
      const marker = extractVariantMarker(meshPrimaryMaterialName(mesh));
      if (marker) {
        candidateGroupKeys.add(marker.groupKey);
      }
    }

    const useGlobalVariantGroups = candidateGroupKeys.size === 0;

    for (const variable of vars) {
      const values = Array.isArray(variable.values) ? variable.values.map((entry) => entry.trim()) : [];
      if (values.length < 2 || !values.every(isNumericToken)) {
        continue;
      }

      const variableName = variable.name.replace(/^\$+/, "").toLowerCase();
      if (variableName.includes("tex")) {
        // Texture-only key vars should not drive mesh visibility groups.
        continue;
      }

      const selected = values[Math.max(0, Math.min(values.length - 1, stateIndex))] ?? values[0];
      if (!selected) {
        continue;
      }

      const resolveSelectedVariant = (byVariant: Map<string, THREE.Mesh[]>): string | null => {
        const numericVariants = Array.from(byVariant.keys())
          .filter((value) => isNumericToken(value))
          .sort((left, right) => Number(left) - Number(right));
        const isBinary01 = values.length === 2 && values[0] === "0" && values[1] === "1";
        const isNudeLike = variableName.endsWith("n") || toggle.name.toLowerCase().includes("nude");

        if (isBinary01 && isNudeLike && numericVariants.length > 2) {
          // In many merged mods, 0 means "follow other variant keys" while 1 means
          // "force nude branch" (typically the highest variant index).
          if (selected === "0") {
            return null;
          }
          return numericVariants[numericVariants.length - 1];
        }

        return selected;
      };

      if (useGlobalVariantGroups) {
        for (const [, byVariant] of meshVariantGroupsRef.current) {
          const selectedVariant = resolveSelectedVariant(byVariant);
          if (selectedVariant === null) {
            applied = true;
            continue;
          }

          applied = true;
          const hasSelected = byVariant.has(selectedVariant);
          for (const [variant, meshes] of byVariant) {
            const visible = hasSelected && variant === selectedVariant;
            for (const mesh of meshes) {
              visibilityByMeshId.set(mesh.uuid, visible);
            }
          }
        }
      } else {
        for (const groupKey of candidateGroupKeys) {
          const byVariant = meshVariantGroupsRef.current.get(groupKey);
          if (!byVariant) {
            continue;
          }

          const selectedVariant = resolveSelectedVariant(byVariant);
          if (selectedVariant === null) {
            applied = true;
            continue;
          }

          applied = true;
          const hasSelected = byVariant.has(selectedVariant);
          for (const [variant, meshes] of byVariant) {
            const visible = hasSelected && variant === selectedVariant;
            for (const mesh of meshes) {
              visibilityByMeshId.set(mesh.uuid, visible);
            }
          }
        }
      }
    }

    return applied;
  };

  const applyVisibilityRules = () => {
    const meshes = meshesRef.current;
    if (meshes.length === 0) {
      setMeshRows([]);
      return;
    }

    if (activeFirstIndices && activeFirstIndices.length > 0) {
      const active = new Set(activeFirstIndices);
      for (const mesh of meshes) {
        const marker = meshFirstIndexMarker(mesh);
        const manual = manualMeshVisibility[mesh.uuid];
        const computed = marker === null ? true : active.has(marker);
        mesh.visible = typeof manual === "boolean" ? manual : computed;
      }

      refreshMeshRows();
      return;
    }

    const groupedByOwner = new Map<string, THREE.Mesh[]>();
    for (const mesh of meshes) {
      const owner = meshOwnerByIdRef.current.get(mesh.uuid);
      if (!owner) {
        continue;
      }
      const group = groupedByOwner.get(owner) ?? [];
      group.push(mesh);
      groupedByOwner.set(owner, group);
    }

    const toggleVisibilityByMeshId = new Map<string, boolean>();
    for (const mesh of meshes) {
      toggleVisibilityByMeshId.set(mesh.uuid, true);
    }

    for (const toggle of previewToggles) {
      const keyName = toggleKeyName(toggle.name);
      const matched = groupedByOwner.get(keyName) ?? [];
      const states = toggleStatesByName[keyName] ?? ["Off", "On"];
      const stateIndex = toggleIndexByName[keyName] ?? 0;

      const variantApplied = applyVariantToggleVisibility(
        toggle,
        stateIndex,
        toggleVisibilityByMeshId,
        matched,
      );
      if (variantApplied) {
        continue;
      }

      if (matched.length === 0) {
        continue;
      }

      if (matched.length > Math.max(8, Math.floor(meshes.length * 0.35))) {
        continue;
      }

      if (states.length <= 2) {
        const visible = stateIndex !== 0;
        for (const mesh of matched) {
          toggleVisibilityByMeshId.set(mesh.uuid, visible);
        }
        continue;
      }

      if (matched.length < 2) {
        const visible = stateIndex > 0;
        for (const mesh of matched) {
          toggleVisibilityByMeshId.set(mesh.uuid, visible);
        }
        continue;
      }

      if (stateIndex === 0) {
        for (const mesh of matched) {
          toggleVisibilityByMeshId.set(mesh.uuid, true);
        }
        continue;
      }

      const selected = (stateIndex - 1) % matched.length;
      matched.forEach((mesh, index) => {
        toggleVisibilityByMeshId.set(mesh.uuid, index === selected);
      });
    }

    for (const mesh of meshes) {
      const manual = manualMeshVisibility[mesh.uuid];
      const toggleVisible = toggleVisibilityByMeshId.get(mesh.uuid) ?? true;
      mesh.visible = typeof manual === "boolean" ? manual : toggleVisible;
    }

    refreshMeshRows();
  };

  useEffect(() => {
    rebuildMeshOwners();
    applyVisibilityRules();
  }, [modelPath, previewToggles]);

  useEffect(() => {
    applyVisibilityRules();
  }, [modelPath, previewToggles, toggleIndexByName, toggleStatesByName, manualMeshVisibility]);

  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.visible = showGrid;
    }
  }, [showGrid]);

  useEffect(() => {
    applyWireframeToModel(wireframeEnabled);
    refreshMeshRows();
  }, [wireframeEnabled]);

  useEffect(() => {
    autoTexturePathRef.current = autoTexturePath;
  }, [autoTexturePath]);

  useEffect(() => {
    textureBindingsRef.current = textureBindings;
  }, [textureBindings]);

  const decodeDdsToDataUrl = async (texturePath: string): Promise<string | null> => {
    try {
      const fileDataUrl = await invoke<string>("load_file_data_url", { path: texturePath });
      const comma = fileDataUrl.indexOf(",");
      if (comma < 0) {
        return null;
      }

      const base64 = fileDataUrl.slice(comma + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }

      const info = parseDDSHeader(bytes as unknown as any);
      if (!info || info.layers.length === 0) {
        return null;
      }

      const rgba = decodeImage(bytes as unknown as any, info.format, info.layers[0]) as unknown as Uint8Array;
      const width = info.layers[0].shape.width;
      const height = info.layers[0].shape.height;
      if (!width || !height || rgba.length < width * height * 4) {
        return null;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return null;
      }

      const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
      ctx.putImageData(imageData, 0, 0);
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  };

  const loadTextureFromPath = async (texturePath: string): Promise<THREE.Texture> => {
    const cached = texturePromiseCacheRef.current.get(texturePath);
    if (cached) {
      return cached;
    }

    const textureLoader = new THREE.TextureLoader();
    const ddsLoader = new DDSLoader();
    const pending = (async () => {
      const rawSrc = toAssetSrc(texturePath);
      let src = rawSrc;
      let useDdsLoader = false;

      try {
        src = await invoke<string>("load_texture_data_url", { path: texturePath });
      } catch {
        if (texturePath.toLowerCase().endsWith(".dds")) {
          const decoded = await decodeDdsToDataUrl(texturePath);
          if (decoded) {
            src = decoded;
          } else {
            useDdsLoader = true;
            src = rawSrc;
          }
        }
      }

      if (useDdsLoader) {
        return await new Promise<THREE.Texture>((resolve, reject) => {
          ddsLoader.load(
            src,
            (texture) => {
              const result = texture as unknown as THREE.Texture;
              result.colorSpace = THREE.SRGBColorSpace;
              result.needsUpdate = true;
              resolve(result);
            },
            undefined,
            reject,
          );
        });
      }

      return await new Promise<THREE.Texture>((resolve, reject) => {
        textureLoader.load(
          src,
          (texture) => {
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.flipY = false;
            texture.needsUpdate = true;
            resolve(texture);
          },
          undefined,
          reject,
        );
      });
    })();

    texturePromiseCacheRef.current.set(texturePath, pending);
    return pending;
  };

  const applyAutoTextureToRoot = (root: THREE.Object3D | null) => {
    if (!root) {
      return;
    }

    const bindings = textureBindingsRef.current;
    const fallbackPath = autoTexturePathRef.current;
    const hasBindings = Object.keys(bindings).length > 0;
    if (!fallbackPath && !hasBindings) {
      return;
    }

    const requestId = ++textureApplyVersionRef.current;
    const materials: THREE.MeshStandardMaterial[] = [];
    root.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) {
        return;
      }

      const mesh = child as THREE.Mesh;
      const entries = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const entry of entries) {
        const material = entry as THREE.MeshStandardMaterial;
        if (!material || !("map" in material)) {
          continue;
        }
        materials.push(material);
      }
    });

    void (async () => {
      let assignedCount = 0;

      for (const material of materials) {
        if (requestId !== textureApplyVersionRef.current) {
          return;
        }

        const key = (material.name || "").toLowerCase();
        const mappedPath = bindings[key] || bindings[material.name] || null;
        if (!mappedPath) {
          continue;
        }

        try {
          const texture = await loadTextureFromPath(mappedPath);
          if (requestId !== textureApplyVersionRef.current) {
            return;
          }
          material.map = texture;
          material.color = new THREE.Color(0xffffff);
          material.needsUpdate = true;
          assignedCount += 1;
        } catch {
          // Keep fallback path for this material.
        }
      }

      if (!fallbackPath) {
        return;
      }

      if (assignedCount === materials.length && materials.length > 0) {
        return;
      }

      try {
        const fallbackTexture = await loadTextureFromPath(fallbackPath);
        if (requestId !== textureApplyVersionRef.current) {
          return;
        }
        for (const material of materials) {
          if (material.map) {
            continue;
          }
          material.map = fallbackTexture;
          material.color = new THREE.Color(0xffffff);
          material.needsUpdate = true;
        }
      } catch {
        // Ignore fallback failures.
      }
    })();
  };

  useEffect(() => {
    if (!modelPath) {
      return;
    }

    const slash = Math.max(modelPath.lastIndexOf("/"), modelPath.lastIndexOf("\\"));
    if (slash < 0) {
      return;
    }

    const metadataPath = `${modelPath.slice(0, slash + 1)}preview_toggles.json`;
    void (async () => {
      try {
        const dataUrl = await invoke<string>("load_file_data_url", { path: metadataPath });
        const comma = dataUrl.indexOf(",");
        if (comma < 0) {
          return;
        }

        const base64 = dataUrl.slice(comma + 1);
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        const text = new TextDecoder("utf-8").decode(bytes);
        const parsed = JSON.parse(text) as PreviewMetadata;

        setPreviewModPath(parsed.mod_path ?? null);

        if (parsed.diffuse_texture_path) {
          setAutoTexturePath(parsed.diffuse_texture_path);
        }
        if (parsed.texture_bindings && typeof parsed.texture_bindings === "object") {
          setTextureBindings(parsed.texture_bindings);
        }
        if (Array.isArray(parsed.toggles)) {
          setPreviewToggles(parsed.toggles);
          const nextStates: Record<string, string[]> = {};
          const nextIndices: Record<string, number> = {};
          for (const toggle of parsed.toggles) {
            const keyName = toggleKeyName(toggle.name);
            const states = parseToggleStates(toggle);
            nextStates[keyName] = states;
            nextIndices[keyName] = 0;
          }
          setToggleStatesByName(nextStates);
          setToggleIndexByName(nextIndices);
        } else {
          setPreviewToggles([]);
          setToggleStatesByName({});
          setToggleIndexByName({});
        }
        setActiveFirstIndices(null);
      } catch {
        // Metadata is optional for manually loaded models.
        setPreviewModPath(null);
        setActiveFirstIndices(null);
        setPreviewToggles([]);
        setToggleStatesByName({});
        setToggleIndexByName({});
      }
    })();
  }, [modelPath]);

  useEffect(() => {
    if (!previewModPath || previewToggles.length === 0 || !modelPath) {
      return;
    }

    const toggleVars: Record<string, string> = {};
    for (const toggle of previewToggles) {
      const keyName = toggleKeyName(toggle.name);
      const stateIndex = toggleIndexByName[keyName] ?? 0;
      for (const variable of toggle.vars ?? []) {
        const values = Array.isArray(variable.values) ? variable.values : [];
        if (values.length === 0) {
          continue;
        }

        const selected = values[Math.max(0, Math.min(values.length - 1, stateIndex))] ?? values[0];
        if (!selected) {
          continue;
        }

        const normalizedName = variable.name.trim();
        if (!normalizedName) {
          continue;
        }

        toggleVars[normalizedName] = selected;
        toggleVars[normalizedName.replace(/^\$+/, "")] = selected;
      }
    }

    if (Object.keys(toggleVars).length === 0) {
      return;
    }

    const slash = Math.max(modelPath.lastIndexOf("/"), modelPath.lastIndexOf("\\"));
    const outputDir = slash >= 0 ? modelPath.slice(0, slash) : null;
    let cancelled = false;

    void (async () => {
      try {
        const resolved = await invoke<Record<string, string>>("resolve_preview_texture_bindings", {
          modPath: previewModPath,
          toggleVars,
          outputDir,
        });

        const activeRanges = await invoke<number[]>("resolve_preview_active_first_indices", {
          modPath: previewModPath,
          toggleVars,
        });

        if (!cancelled) {
          setActiveFirstIndices(Array.isArray(activeRanges) && activeRanges.length > 0 ? activeRanges : null);
        }

        if (cancelled || !resolved || Object.keys(resolved).length === 0) {
          return;
        }

        setTextureBindings(resolved);
      } catch {
        if (!cancelled) {
          setActiveFirstIndices(null);
        }
        // Keep current bindings when dynamic resolution fails.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [modelPath, previewModPath, previewToggles, toggleIndexByName]);

  useEffect(() => {
    applyAutoTextureToRoot(activeModelRef.current);
  }, [modelPath, textureBindings, autoTexturePath]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#020617");

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    camera.position.set(0, 1.4, 2.6);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.target.set(0, 1, 0);

    const ambient = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(4, 6, 4);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x7dd3fc, 0.45);
    fillLight.position.set(-3, 2, -4);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(20, 20, 0x1e293b, 0x0f172a);
    grid.visible = showGrid;
    scene.add(grid);
    gridRef.current = grid;

    mount.appendChild(renderer.domElement);

    let disposed = false;
    let activeModel: THREE.Object3D | null = null;

    const fitRenderer = () => {
      if (!mount) {
        return;
      }
      const width = Math.max(320, mount.clientWidth);
      const height = Math.max(280, mount.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    fitRenderer();

    const observer = new ResizeObserver(() => {
      fitRenderer();
    });
    observer.observe(mount);

    const loader = new GLTFLoader();

    const resetViewToObject = (obj: THREE.Object3D) => {
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z) * 0.5;
      const distance = Math.max(2, radius * 3.4);

      controls.target.copy(center);
      camera.position.set(center.x, center.y + radius * 0.4, center.z + distance);
      camera.near = Math.max(0.01, distance / 500);
      camera.far = Math.max(100, distance * 40);
      camera.updateProjectionMatrix();
      controls.update();
    };

    const loadModel = async () => {
      if (!modelPath) {
        setError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      const attachModel = (gltf: GLTF) => {
        if (disposed) {
          return;
        }

        if (activeModel) {
          scene.remove(activeModel);
        }

        activeModel = gltf.scene;
        activeModelRef.current = gltf.scene;

        const loadedMeshes: THREE.Mesh[] = [];
        gltf.scene.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            loadedMeshes.push(child as THREE.Mesh);
          }
        });
        meshesRef.current = loadedMeshes;

        scene.add(gltf.scene);
        applyAutoTextureToRoot(gltf.scene);
        setManualMeshVisibility({});
        rebuildVariantGroups();
        rebuildMeshOwners();
        applyWireframeToModel(wireframeEnabled);
        applyVisibilityRules();
        resetViewToObject(gltf.scene);
        setLoading(false);
      };

      const failModel = (loadErr: unknown) => {
        if (disposed) {
          return;
        }
        setLoading(false);
        setError(loadErr instanceof Error ? loadErr.message : "Could not load model.");
      };

      try {
        const dataUrl = await invoke<string>("load_file_data_url", { path: modelPath });
        loader.load(dataUrl, attachModel, undefined, () => {
          const src = toAssetSrc(modelPath);
          loader.load(src, attachModel, undefined, failModel);
        });
      } catch {
        const src = toAssetSrc(modelPath);
        loader.load(src, attachModel, undefined, failModel);
      }
    };

    void loadModel();

    const renderLoop = () => {
      if (disposed) {
        return;
      }
      controls.update();
      renderer.render(scene, camera);
      requestAnimationFrame(renderLoop);
    };
    requestAnimationFrame(renderLoop);

    return () => {
      disposed = true;
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      if (activeModel) {
        scene.remove(activeModel);
      }
      meshesRef.current = [];
      meshOwnerByIdRef.current.clear();
      setMeshRows([]);
      activeModelRef.current = null;
      gridRef.current = null;
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [modelPath, toAssetSrc]);

  return (
    <section className="mt-4 rounded-[28px] border border-white/10 bg-slate-950/45 p-6 shadow-[0_20px_80px_rgba(2,6,23,0.35)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Developer Preview</p>
          <h2 className="mt-2 text-xl font-semibold text-white">Custom GLB Model Preview</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void (async () => {
                const picked = await open({
                  multiple: false,
                  directory: false,
                  title: "Select GLB/GLTF model",
                  filters: [{ name: "3D Models", extensions: ["glb", "gltf"] }],
                });

                if (!picked) {
                  return;
                }

                const path = Array.isArray(picked) ? (picked[0] ?? "") : picked;
                onModelPathChange(path || "");
              })();
            }}
            className="inline-flex items-center gap-2 rounded-full border border-cyan-300/35 bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25"
          >
            Select Model
          </button>
          <button
            type="button"
            onClick={() => {
              onModelPathChange("");
            }}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/12"
            disabled={!modelPath}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => {
              setShowGrid((current) => !current);
            }}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/12"
          >
            Grid: {showGrid ? "On" : "Off"}
          </button>
          <button
            type="button"
            onClick={() => {
              setWireframeEnabled((current) => !current);
            }}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/12"
          >
            Wireframe: {wireframeEnabled ? "On" : "Off"}
          </button>
          <button
            type="button"
            disabled={Object.keys(manualMeshVisibility).length === 0}
            onClick={() => {
              setManualMeshVisibility({});
            }}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/8 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset Mesh Overrides
          </button>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-cyan-300/20 bg-cyan-500/8 p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
            <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Dump folder (optional)</span>
            <div className="mt-2 flex gap-2">
              <input
                value={dumpPath}
                onChange={(event) => {
                  setDumpPath(event.currentTarget.value);
                }}
                placeholder="Optional 3DMigoto dump folder"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1.5 text-xs text-white"
              />
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const picked = await open({ directory: true, multiple: false, title: "Select dump folder" });
                    if (!picked) return;
                    const path = Array.isArray(picked) ? (picked[0] ?? "") : picked;
                    setDumpPath(path || "");
                  })();
                }}
                className="rounded-lg border border-cyan-300/35 bg-cyan-500/15 px-2 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/25"
              >
                Browse
              </button>
            </div>
          </label>

          <label className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
            <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Mod folder</span>
            <div className="mt-2 flex gap-2">
              <input
                value={modPath}
                onChange={(event) => {
                  setModPath(event.currentTarget.value);
                }}
                placeholder="Select installed mod folder"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1.5 text-xs text-white"
              />
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const picked = await open({ directory: true, multiple: false, title: "Select mod folder" });
                    if (!picked) return;
                    const path = Array.isArray(picked) ? (picked[0] ?? "") : picked;
                    setModPath(path || "");
                  })();
                }}
                className="rounded-lg border border-cyan-300/35 bg-cyan-500/15 px-2 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/25"
              >
                Browse
              </button>
            </div>
          </label>

          <label className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
            <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Output folder (optional)</span>
            <div className="mt-2 flex gap-2">
              <input
                value={outputPath}
                onChange={(event) => {
                  setOutputPath(event.currentTarget.value);
                }}
                placeholder="Defaults to mod/preview_build"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/70 px-2 py-1.5 text-xs text-white"
              />
              <button
                type="button"
                onClick={() => {
                  void (async () => {
                    const picked = await open({ directory: true, multiple: false, title: "Select output folder" });
                    if (!picked) return;
                    const path = Array.isArray(picked) ? (picked[0] ?? "") : picked;
                    setOutputPath(path || "");
                  })();
                }}
                className="rounded-lg border border-cyan-300/35 bg-cyan-500/15 px-2 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/25"
              >
                Browse
              </button>
            </div>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={buildBusy || !modPath.trim()}
            onClick={() => {
              void (async () => {
                setBuildBusy(true);
                setBuildMsg(null);
                try {
                  const result = await invoke<PreviewBuildResult>("build_preview_glb_from_dump", {
                    dumpPath: dumpPath.trim(),
                    modPath,
                    outputDir: outputPath.trim() ? outputPath.trim() : null,
                  });
                  if (result.model_path) {
                    onModelPathChange(result.model_path);
                  }
                  setAutoTexturePath(result.diffuse_texture_path);
                  setTextureBindings(result.texture_bindings ?? {});
                  setBuildMsg(result.message);
                } catch (invokeErr) {
                  setTextureBindings({});
                  setBuildMsg(invokeErr instanceof Error ? invokeErr.message : String(invokeErr));
                } finally {
                  setBuildBusy(false);
                }
              })();
            }}
            className="inline-flex items-center gap-2 rounded-full border border-cyan-300/35 bg-cyan-500/15 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {buildBusy ? "Building..." : "Build preview package"}
          </button>
        </div>

        {buildMsg ? <p className="mt-3 break-all text-xs text-cyan-100/90">{buildMsg}</p> : null}
      </div>
      {modelPath ? (
        <p className="mt-2 break-all font-mono text-xs text-slate-400">{modelPath}</p>
      ) : (
        <p className="mt-2 text-xs text-slate-400">No model selected yet.</p>
      )}

      <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-white/10 bg-slate-950 p-2 lg:flex-row">
        <aside className="w-full rounded-xl border border-emerald-300/20 bg-emerald-500/5 p-3 lg:w-80 lg:shrink-0">
          <p className="text-[11px] uppercase tracking-[0.18em] text-emerald-200/80">Meshes</p>
          <h3 className="mt-1 text-sm font-semibold text-emerald-100">Manual Visibility</h3>

          {meshRows.length === 0 ? (
            <p className="mt-3 text-xs text-slate-300/80">No mesh list yet. Load a model first.</p>
          ) : (
            <div className="mt-3 max-h-[58dvh] space-y-2 overflow-y-auto pr-1">
              {meshRows.map((row) => (
                <div key={row.id} className="rounded-lg border border-white/10 bg-slate-900/70 p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-white">{row.name}</p>
                      <p className="truncate text-[11px] text-slate-300/75">{row.material}</p>
                    </div>
                    <span
                      className={row.visible
                        ? "rounded-md border border-emerald-300/35 bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-100"
                        : "rounded-md border border-rose-300/35 bg-rose-500/20 px-2 py-0.5 text-[10px] text-rose-100"}
                    >
                      {row.visible ? "Visible" : "Hidden"}
                    </span>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setManualMeshVisibility((current) => ({
                          ...current,
                          [row.id]: !row.visible,
                        }));
                      }}
                      className="rounded-md border border-emerald-300/35 bg-emerald-500/15 px-2 py-1 text-[11px] text-emerald-100 hover:bg-emerald-500/25"
                    >
                      Toggle
                    </button>
                    <button
                      type="button"
                      disabled={!row.manual}
                      onClick={() => {
                        setManualMeshVisibility((current) => {
                          const next = { ...current };
                          delete next[row.id];
                          return next;
                        });
                      }}
                      className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[11px] text-slate-100 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Clear Override
                    </button>
                    {row.manual ? <span className="text-[11px] text-amber-200">Manual</span> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>

        <div className="min-w-0 flex-1">
          <div ref={mountRef} className="h-[70dvh] w-full overflow-hidden rounded-xl border border-white/10 bg-slate-950/80" />
        </div>

        <aside className="w-full rounded-xl border border-cyan-300/20 bg-cyan-500/5 p-3 lg:w-80 lg:shrink-0">
          <p className="text-[11px] uppercase tracking-[0.18em] text-cyan-200/80">Model Toggles</p>
          <h3 className="mt-1 text-sm font-semibold text-cyan-100">INI Toggle States</h3>

          {previewToggles.length === 0 ? (
            <p className="mt-3 text-xs text-slate-300/80">No toggle definitions found in preview metadata.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {previewToggles.map((toggle) => {
                const keyName = toggleKeyName(toggle.name);
                const states = toggleStatesByName[keyName] ?? ["Off", "On"];
                const stateIndex = toggleIndexByName[keyName] ?? 0;
                const safeIndex = Math.max(0, Math.min(states.length - 1, stateIndex));

                return (
                  <div key={keyName} className="rounded-lg border border-white/10 bg-slate-900/70 p-2">
                    <p className="truncate text-xs font-semibold text-white">{toggleDisplayName(toggle.name)}</p>
                    <p className="mt-1 text-[11px] text-slate-300/80">Key: {toggle.key}{toggle.back ? `, Back: ${toggle.back}` : ""}</p>

                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setToggleIndexByName((current) => {
                            const count = Math.max(1, states.length);
                            const prev = current[keyName] ?? 0;
                            return {
                              ...current,
                              [keyName]: (prev - 1 + count) % count,
                            };
                          });
                        }}
                        className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[11px] text-slate-100 hover:bg-white/15"
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setToggleIndexByName((current) => {
                            const count = Math.max(1, states.length);
                            const prev = current[keyName] ?? 0;
                            return {
                              ...current,
                              [keyName]: (prev + 1) % count,
                            };
                          });
                        }}
                        className="rounded-md border border-cyan-300/35 bg-cyan-500/15 px-2 py-1 text-[11px] text-cyan-100 hover:bg-cyan-500/25"
                      >
                        Next
                      </button>
                      <span className="min-w-0 truncate rounded-md border border-cyan-300/20 bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-100">
                        {safeIndex + 1}/{states.length}: {states[safeIndex]}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>

      {loading ? <p className="mt-2 text-xs text-cyan-100/90">Loading model...</p> : null}
      {error ? <p className="mt-2 text-xs text-rose-200/90">Model load failed: {error}</p> : null}
    </section>
  );
}
