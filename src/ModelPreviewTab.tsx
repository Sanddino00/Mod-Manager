import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
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
};

type PreviewMetadata = {
  diffuse_texture_path?: string | null;
  texture_bindings?: Record<string, string>;
  toggles?: PreviewToggleEntry[];
};

function parseToggleStates(toggle: PreviewToggleEntry): string[] {
  const tokens = new Set<string>();
  const seed = [toggle.key, toggle.back ?? ""];
  for (const chunk of seed) {
    for (const value of String(chunk)
      .split(/[|,/]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      tokens.add(value);
    }
  }

  if (tokens.size === 0) {
    return ["Off", "On"];
  }

  if (tokens.size === 1) {
    return ["Off", ...tokens];
  }

  return Array.from(tokens);
}

function toggleKeyName(toggleName: string): string {
  return toggleName.trim().toLowerCase();
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
  const [autoTexturePath, setAutoTexturePath] = useState<string | null>(null);
  const [textureBindings, setTextureBindings] = useState<Record<string, string>>({});
  const [previewToggles, setPreviewToggles] = useState<PreviewToggleEntry[]>([]);
  const [toggleStatesByName, setToggleStatesByName] = useState<Record<string, string[]>>({});
  const [toggleIndexByName, setToggleIndexByName] = useState<Record<string, number>>({});
  const activeModelRef = useRef<THREE.Object3D | null>(null);

  useEffect(() => {
    const root = activeModelRef.current;
    if (!root) {
      return;
    }

    const meshes: THREE.Mesh[] = [];
    root.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        meshes.push(child as THREE.Mesh);
      }
    });

    for (const mesh of meshes) {
      mesh.visible = true;
    }

    const findMatches = (toggleName: string): THREE.Mesh[] => {
      const normalized = toggleName.toLowerCase().replace(/[^a-z0-9]+/g, " ");
      const tokens = normalized
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && token !== "key");
      if (tokens.length === 0) {
        return [];
      }

      return meshes.filter((mesh) => {
        const label = `${mesh.name || ""} ${(mesh.material as { name?: string } | null)?.name || ""}`.toLowerCase();
        return tokens.some((token) => label.includes(token));
      });
    };

    const meshOwner = new Map<THREE.Mesh, string>();
    for (const toggle of previewToggles) {
      const keyName = toggleKeyName(toggle.name);
      for (const mesh of findMatches(toggle.name)) {
        if (!meshOwner.has(mesh)) {
          meshOwner.set(mesh, keyName);
        }
      }
    }

    for (const toggle of previewToggles) {
      const keyName = toggleKeyName(toggle.name);
      const states = toggleStatesByName[keyName] ?? ["Off", "On"];
      const stateIndex = toggleIndexByName[keyName] ?? 0;
      const matched = findMatches(toggle.name).filter((mesh) => meshOwner.get(mesh) === keyName);

      if (matched.length === 0) {
        continue;
      }

      if (matched.length > Math.max(8, Math.floor(meshes.length * 0.35))) {
        continue;
      }

      if (states.length <= 2) {
        const visible = stateIndex !== 0;
        for (const mesh of matched) {
          mesh.visible = visible;
        }
        continue;
      }

      if (matched.length < 2) {
        const visible = stateIndex > 0;
        for (const mesh of matched) {
          mesh.visible = visible;
        }
        continue;
      }

      if (stateIndex === 0) {
        for (const mesh of matched) {
          mesh.visible = true;
        }
        continue;
      }

      const selected = (stateIndex - 1) % matched.length;
      matched.forEach((mesh, index) => {
        mesh.visible = index === selected;
      });
    }
  }, [modelPath, previewToggles, toggleIndexByName, toggleStatesByName]);

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
        const text = atob(base64);
        const parsed = JSON.parse(text) as PreviewMetadata;

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
            nextIndices[keyName] = states.length >= 2 ? 1 : 0;
          }
          setToggleStatesByName(nextStates);
          setToggleIndexByName(nextIndices);
        } else {
          setPreviewToggles([]);
          setToggleStatesByName({});
          setToggleIndexByName({});
        }
      } catch {
        // Metadata is optional for manually loaded models.
        setPreviewToggles([]);
        setToggleStatesByName({});
        setToggleIndexByName({});
      }
    })();
  }, [modelPath]);

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
    scene.add(grid);

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

      const applyAutoTexture = (root: THREE.Object3D) => {
        const hasBindings = Object.keys(textureBindings).length > 0;
        if (!autoTexturePath && !hasBindings) {
          return;
        }

        const textureLoader = new THREE.TextureLoader();
        const texturePromiseCache = new Map<string, Promise<THREE.Texture>>();

        const loadTextureFromPath = (texturePath: string): Promise<THREE.Texture> => {
          const cached = texturePromiseCache.get(texturePath);
          if (cached) {
            return cached;
          }

          const pending = (async () => {
            let src = toAssetSrc(texturePath);
            try {
              src = await invoke<string>("load_texture_data_url", { path: texturePath });
            } catch {
              if (texturePath.toLowerCase().endsWith(".dds")) {
                const decoded = await decodeDdsToDataUrl(texturePath);
                if (decoded) {
                  src = decoded;
                }
              }
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

          texturePromiseCache.set(texturePath, pending);
          return pending;
        };

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
            const key = (material.name || "").toLowerCase();
            const mappedPath = textureBindings[key] || textureBindings[material.name] || null;
            if (!mappedPath) {
              continue;
            }

            try {
              const texture = await loadTextureFromPath(mappedPath);
              material.map = texture;
              material.color = new THREE.Color(0xffffff);
              material.needsUpdate = true;
              assignedCount += 1;
            } catch {
              // Keep fallback path for this material.
            }
          }

          if (!autoTexturePath) {
            return;
          }

          if (assignedCount === materials.length && materials.length > 0) {
            return;
          }

          try {
            const fallbackTexture = await loadTextureFromPath(autoTexturePath);
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

      const attachModel = (gltf: GLTF) => {
        if (disposed) {
          return;
        }

        if (activeModel) {
          scene.remove(activeModel);
        }

        activeModel = gltf.scene;
        activeModelRef.current = gltf.scene;
        scene.add(gltf.scene);
        applyAutoTexture(gltf.scene);
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
      activeModelRef.current = null;
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [autoTexturePath, modelPath, textureBindings, toAssetSrc]);

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
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-cyan-300/20 bg-cyan-500/8 p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="rounded-xl border border-white/10 bg-slate-900/60 p-3">
            <span className="text-[11px] uppercase tracking-[0.18em] text-slate-400">Dump folder</span>
            <div className="mt-2 flex gap-2">
              <input
                value={dumpPath}
                onChange={(event) => {
                  setDumpPath(event.currentTarget.value);
                }}
                placeholder="Select 3DMigoto dump folder"
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
            disabled={buildBusy || !dumpPath.trim() || !modPath.trim()}
            onClick={() => {
              void (async () => {
                setBuildBusy(true);
                setBuildMsg(null);
                try {
                  const result = await invoke<PreviewBuildResult>("build_preview_glb_from_dump", {
                    dumpPath,
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
                    <p className="truncate text-xs font-semibold text-white">{toggle.name}</p>
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
