# Version 1.2.3
# modmanager.py - Mod Manager GUI with update checks and settings
# NOTE: Designed to be run with Python 3.10+ and PyQt6 installed.
# Uses only stdlib network (urllib) to avoid extra pip deps for update check.

import sys
import os
import json
import shutil
import subprocess
import threading
import queue
import configparser
import re
import html
import urllib.request
import urllib.error
from urllib.parse import urlparse, urlencode, quote
import zipfile
import tempfile
import webbrowser
from packaging import version as pkg_version  # packaging is often available; fallback handled below
from PyQt6.QtWidgets import (
    QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout, QPushButton,
    QComboBox, QTabWidget, QGridLayout, QScrollArea, QFrame, QFileDialog,
    QListWidget, QListWidgetItem, QCheckBox, QMessageBox, QLineEdit, QTextEdit,
    QInputDialog, QSizePolicy, QStackedWidget, QProgressBar
)
from PyQt6.QtGui import QPixmap, QFont, QImageReader
from PyQt6.QtCore import Qt, QTimer, QMetaObject, QEvent
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# -------------------- Version & BASE DIRECTORY --------------------
DEFAULT_VERSION = "1.2.3"

if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

RESOURCES = os.path.join(BASE_DIR, "resources")
os.makedirs(RESOURCES, exist_ok=True)
SETTINGS_FILE = os.path.join(RESOURCES, "settings.json")

def _parse_version_string(value):
    if not value:
        return None
    parts = value.split(".")
    if not parts or not all(p.isdigit() for p in parts):
        return None
    return value

def get_version_from_resources(resources_dir, fallback):
    """Return latest version based on '*.txt' filenames in resources."""
    try:
        candidates = []
        for name in os.listdir(resources_dir):
            if not name.lower().endswith(".txt"):
                continue
            version_str = _parse_version_string(name[:-4])
            if version_str:
                candidates.append(version_str)
        if not candidates:
            return fallback
        try:
            return max(candidates, key=pkg_version.parse)
        except Exception:
            def as_tuple(v):
                return tuple(int(p) for p in v.split("."))
            return max(candidates, key=as_tuple)
    except Exception:
        return fallback

SCRIPT_VERSION = get_version_from_resources(RESOURCES, DEFAULT_VERSION)

# -------------------- CONFIG --------------------
GAMES = {"gi": "Genshin Impact", "hsr": "Honkai Star Rail", "wuwa": "Wuthering Waves", "zzz": "Zenless Zone Zero", "end": "Endfield"}
GAMEBANANA_URLS = {
    "gi": "https://gamebanana.com/games/8552",
    "hsr": "https://gamebanana.com/games/18366",
    "wuwa": "https://gamebanana.com/games/20357",
    "zzz": "https://gamebanana.com/games/19567",
    "end": "https://gamebanana.com/games/21842",
}
RABBITFX_URLS = {
    "wuwa": "https://gamebanana.com/mods/527815",
    "hsr": "https://gamebanana.com/mods/608041",
    "zzz": "https://gamebanana.com/mods/531649",
    "end": "https://gamebanana.com/mods/651557",
}
BROWSE_GAME_DATA = {
    "gi": {
        "game_id": "8552",
        "types": [
            {"name": "Characters", "id": 18140},
            {"name": "Weapons", "id": 18137},
            {"name": "Other", "id": 12526},
            {"name": "UI", "id": 22474},
            {"name": "Objects", "id": 18310},
            {"name": "Entity", "id": 22725},
            {"name": "Gadget", "id": 23574},
            {"name": "Waverider", "id": 24279},
        ],
    },
    "hsr": {
        "game_id": "18366",
        "types": [
            {"name": "Characters", "id": 22832},
            {"name": "Weapons", "id": 22833},
            {"name": "UI", "id": 22830},
            {"name": "Other", "id": 22628},
            {"name": "Objects", "id": 22829},
            {"name": "Entity", "id": 23974},
        ],
    },
    "wuwa": {
        "game_id": "20357",
        "types": [
            {"name": "Skins", "id": 29524},
            {"name": "UI", "id": 29496},
            {"name": "Other", "id": 29493},
        ],
    },
    "zzz": {
        "game_id": "19567",
        "types": [
            {"name": "Characters", "id": 30305},
            {"name": "Bangboo", "id": 30702},
            {"name": "Other", "id": 29874},
            {"name": "UI", "id": 30395},
        ],
    },
    "end": {
        "game_id": "21842",
        "types": [
            {"name": "Operators", "id": 42770},
            {"name": "Weapons", "id": 42772},
            {"name": "UI", "id": 42706},
            {"name": "Other", "id": 42780},
        ],
    },
}

BROWSE_SORTS = [
    ("Default", "default"),
    ("Newest", "new"),
    ("Updated", "updated"),
    ("Popular", "popular"),
]

CATEGORIES = ["characters", "weapons", "ui", "objects", "npcs", "buffervalues"]

GITHUB_RELEASES_API = "https://api.github.com/repos/Sanddino00/Mod-Manager/releases/latest"
# expected filenames in release:
EXPECTED_UPDATE_EXE_NAME = "update.exe"      # name of the installer/updater exe in releases
EXPECTED_RESOURCES_ZIP_NAME = "resources.zip"  # name of resources zip in releases
EXPECTED_MODMANAGER_EXE_NAME = "modmanager.exe"

def save_settings():
    try:
        with open(SETTINGS_FILE, "w") as f:
            json.dump(settings, f, indent=2)
    except Exception as e:
        print("Failed to save settings:", e)
# -------------------- SETTINGS --------------------
default_mod_paths = {
    "gi": os.path.join(BASE_DIR, "gimi", "mods"),
    "hsr": os.path.join(BASE_DIR, "srmi", "mods"),
    "wuwa": os.path.join(BASE_DIR, "wwmi", "mods"),
    "zzz": os.path.join(BASE_DIR, "zzmi", "mods"),
    "end": os.path.join(BASE_DIR, "efmi", "mods")
}

if not os.path.exists(SETTINGS_FILE):
    settings = {
        "mod_paths": default_mod_paths,
        "theme": "dark",  # Dark mode default
            "script_targets": {},
        "version": SCRIPT_VERSION,
        "auto_check_updates": False,
        "last_release_tag": None,
        "install_path_info": None,  # path storage for installer/updater if needed
        "last_selected_game": "gi",
        "window_width": 1200,
        "window_height": 800,
        "window_x": 100,
        "window_y": 100,
        "favorites": {}  # {game: [item_ids]}
    }
    os.makedirs(RESOURCES, exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)
else:
    with open(SETTINGS_FILE, "r") as f:
        try:
            settings = json.load(f)
        except Exception:
            # fallback to defaults if parse fails
            settings = {
                "mod_paths": default_mod_paths,
                "theme": "dark",
                "script_targets": {},
                "version": SCRIPT_VERSION,
                "auto_check_updates": False,
                "last_release_tag": None,
                "install_path_info": None,
                "last_selected_game": "gi",
                "window_width": 1200,
                "window_height": 800,
                "favorites": {}
            }
# After loading settings (both new and existing)
if settings.get("version") != SCRIPT_VERSION:
    settings["version"] = SCRIPT_VERSION
    save_settings()
settings.setdefault("script_targets", {})
settings.setdefault("favorites", {})
settings.setdefault("right_click_toggle_mods", False)

# -------------------- WATCHDOG --------------------
class ModFolderHandler(FileSystemEventHandler):
    def __init__(self, callback):
        self.callback = callback
    def on_any_event(self, event):
        # ignore temporary events
        self.callback()

# -------------------- CUSTOM WIDGETS --------------------
class ModListWidget(QListWidget):
    """Custom QListWidget that accepts external drops (drag from file explorer)."""
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.viewport().setAcceptDrops(True)
        self.setDragDropMode(QListWidget.DragDropMode.DropOnly)
        self.setDefaultDropAction(Qt.DropAction.CopyAction)
        self.mod_manager = None  # Will be set by ModManager
    
    def dragEnterEvent(self, event):
        """Accept drag if it contains files/folders."""
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            super().dragEnterEvent(event)

    def dragMoveEvent(self, event):
        """Keep accepting external file drags while moving over the list."""
        if event.mimeData().hasUrls():
            event.setDropAction(Qt.DropAction.CopyAction)
            event.accept()
        else:
            super().dragMoveEvent(event)
    
    def dropEvent(self, event):
        """Handle dropping folders/files from file explorer."""
        try:
            if event.mimeData().hasUrls():
                for url in event.mimeData().urls():
                    path = url.toLocalFile()
                    if path and self.mod_manager:
                        self.mod_manager.import_mod_source(path)
                event.acceptProposedAction()
            else:
                super().dropEvent(event)
        except Exception as e:
            print(f"Error dropping mod: {e}")

    def contextMenuEvent(self, event):
        # Right-click to toggle mod if enabled in settings
        try:
            if not getattr(self, 'mod_manager', None):
                return
            if not settings.get('right_click_toggle_mods', False):
                return
            item = self.itemAt(event.pos())
            if not item:
                return
            path = item.data(Qt.ItemDataRole.UserRole)
            if not path:
                return
            # Toggle the mod at this path
            try:
                self.mod_manager.toggle_mod_by_path(path)
            except Exception as e:
                print(f"Failed to toggle via right-click: {e}")
        except Exception:
            pass

# -------------------- UTILITIES --------------------

def get_added_characters_file(game):
    """Get the path to the addedCharacters JSON file for a specific game."""
    return os.path.join(RESOURCES, f"addedCharacters_{game}.json")

def load_added_characters(game):
    """Load added characters from the game's addedCharacters JSON file."""
    file_path = get_added_characters_file(game)
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []
    return []

def save_added_characters(game, characters):
    """Save added characters to the game's addedCharacters JSON file."""
    file_path = get_added_characters_file(game)
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(characters, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"Failed to save added characters for {game}: {e}")


def get_category_folder_name(category):
    """Map UI category keys to on-disk folder names."""
    if (category or "").lower() == "buffervalues":
        return "BufferValues"
    return category


def build_item_folder_path(base_path, category, item_id=None):
    """Build item folder path with support for category-root pseudo items."""
    cat_folder = os.path.join(base_path, get_category_folder_name(category))
    if (category or "").lower() == "buffervalues" and (item_id is None or item_id == "__root__"):
        return cat_folder
    if item_id is None:
        return cat_folder
    return os.path.join(cat_folder, item_id)


def get_favorites_file(game):
    """Return the per-game favorites filename (JSON). Example: resources/gi_fav_char.json"""
    return os.path.join(RESOURCES, f"{game}_fav_char.json")


def load_favorites(game):
    """Load favorites for a specific game from its JSON file.

    Falls back to the in-settings favorites entry for backward compatibility.
    Returns a list of item ids.
    """
    file_path = get_favorites_file(game)
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
        except Exception:
            return []
    # fallback to old settings store
    return settings.get("favorites", {}).get(game, [])


def save_favorites(game, fav_list):
    """Save favorites list for a specific game to its JSON file."""
    file_path = get_favorites_file(game)
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(fav_list, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"Failed to save favorites for {game}: {e}")


# Migrate any existing favorites stored in settings.json into per-game files.
try:
    old_favs = settings.get("favorites", {})
    if isinstance(old_favs, dict) and old_favs:
        migrated = False
        for g, lst in list(old_favs.items()):
            if lst:
                # Only migrate if per-game file doesn't already exist
                fp = get_favorites_file(g)
                if not os.path.exists(fp):
                    try:
                        with open(fp, "w", encoding="utf-8") as f:
                            json.dump(lst, f, indent=2, ensure_ascii=False)
                        migrated = True
                    except Exception:
                        pass
        if migrated:
            # remove old entry and save settings
            settings.pop("favorites", None)
            save_settings()
except Exception:
    pass

def semver_normalize(tag):
    """Strip leading 'v' and return normalized semver string."""
    if not tag:
        return None
    t = tag.strip()
    if t.startswith("v.") or t.startswith("V."):
        t = t[2:]
    elif t.startswith("v") or t.startswith("V"):
        t = t[1:]
    return t

def is_version_newer(installed, latest):
    """Compare semver strings. Returns True if latest > installed."""
    try:
        # prefer packaging.version if available
        return pkg_version.parse(latest) > pkg_version.parse(installed)
    except Exception:
        # fallback naive compare
        try:
            i_parts = [int(x) for x in installed.split(".") if x.isdigit()]
            l_parts = [int(x) for x in latest.split(".") if x.isdigit()]
            return l_parts > i_parts
        except Exception:
            return latest != installed and latest is not None

def fetch_latest_release_info():
    """Return dict with latest release JSON or None on error."""
    try:
        req = urllib.request.Request(GITHUB_RELEASES_API, headers={"User-Agent": "ModManager-Updater"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read().decode("utf-8")
            return json.loads(data)
    except urllib.error.HTTPError as he:
        print("HTTP error fetching release info:", he)
    except Exception as e:
        print("Error fetching release info:", e)
    return None

def download_url_to_path(url, dest_path, progress_callback=None):
    """
    Download a URL to destination path. Calls progress_callback(received, total) if provided.
    Returns True on success.
    """
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ModManager-Updater"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = resp.getheader('Content-Length')
            total = int(total) if total and total.isdigit() else None
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            with open(dest_path, "wb") as out:
                downloaded = 0
                block_size = 8192
                while True:
                    chunk = resp.read(block_size)
                    if not chunk:
                        break
                    out.write(chunk)
                    downloaded += len(chunk)
                    if progress_callback:
                        try:
                            progress_callback(downloaded, total)
                        except Exception:
                            pass
        return True
    except Exception as e:
        print(f"Download failed ({url} -> {dest_path}):", e)
        return False


def guess_image_extension_from_url(url, default_ext=".jpg"):
    """Guess image extension from URL path. Falls back to default when unknown."""
    try:
        path = urlparse(url).path
        ext = os.path.splitext(path)[1].lower()
        if ext in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"):
            return ext
    except Exception:
        pass
    return default_ext

def find_all_images_recursive(folder_path):
    """Return a list of all image file paths inside folder and subfolders."""
    image_paths = []
    for root, dirs, files in os.walk(folder_path):
        for f in files:
            if f.lower().endswith(('.webp', '.png', '.jpg', '.jpeg', '.bmp', '.gif')):
                image_paths.append(os.path.join(root, f))
    return image_paths

def open_folder(path):
    if sys.platform == "win32":
        os.startfile(path)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])

# -------------------- MOD MANAGER GUI --------------------
class ModManager(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Mod Manager")
        self.setAcceptDrops(True)
        # Load window size from settings
        width = settings.get("window_width", 1200)
        height = settings.get("window_height", 800)
        self.resize(width, height)
        # Load window position if present
        wx = settings.get("window_x")
        wy = settings.get("window_y")
        if isinstance(wx, int) and isinstance(wy, int):
            try:
                self.move(wx, wy)
            except Exception:
                pass
        # Load last selected game from settings
        self.selected_game = settings.get("last_selected_game", "gi")
        self.selected_category = "characters"
        self.selected_item = None
        self.items = []
        self.selected_mod_path = None
        self.selected_ini_path = None
        self.ini_entries = []
        self.search_results_data = {}  # Store search results for navigation
        self.search_debounce_timer = None  # Debounce timer for search
        self.resize_debounce_timer = None  # Debounce timer for resize
        self.update_prompt_shown_for_tag = None
        self.update_prompt_open = False
        self.browse_categories = []
        self.browse_results_data = []
        self.browse_selected_mod = None
        self.browse_selected_file = None
        self.browse_selected_index = -1
        self.browse_selected_type = None
        self.browse_route = ("home", None)
        self.browse_current_page = 1
        self.browse_has_more = False
        self.browse_loading = False
        self.browse_preview_cache = {}
        self.browse_card_frames = []
        self.browse_card_img_labels = []
        self.browse_message_queue = queue.Queue()
        self.browse_request_token = 0
        self.browse_categories_token = 0
        self.browse_mods_token = 0
        self.browse_detail_token = 0
        self.browse_download_queue = []
        self.browse_download_current = None
        self.browse_download_history = []
        self.browse_download_counter = 0
        self.mod_refresh_timer = QTimer()
        self.mod_refresh_timer.setSingleShot(True)
        self.mod_refresh_timer.timeout.connect(self.load_mods)
        self.browse_poll_timer = QTimer()
        self.browse_poll_timer.setInterval(50)
        self.browse_poll_timer.timeout.connect(self._process_browse_queue)
        self.browse_poll_timer.start()
        self._loading_mods = False

        self.observer = Observer()
        self.observer.start()

        self.ensure_buffer_values_folders()

        self.init_ui()
        self._register_drop_targets()
        # load items and start background update check
        self.load_items()
        QTimer.singleShot(500, self.start_update_check)
        QTimer.singleShot(1000, self.auto_update_installer)

    def _start_mod_refresh_timer(self):
        try:
            if self.mod_refresh_timer.isActive():
                self.mod_refresh_timer.stop()
            self.mod_refresh_timer.start(150)
        except Exception:
            pass

    def _register_drop_targets(self):
        """Register widgets that should accept external drag/drop imports."""
        targets = [
            self,
            getattr(self, "content_stack", None),
            getattr(self, "detail_page", None),
            getattr(self, "mod_list_widget", None),
            getattr(self.mod_list_widget, "viewport", lambda: None)(),
            getattr(self, "preview_label", None),
        ]
        for widget in targets:
            if widget is None:
                continue
            try:
                widget.setAcceptDrops(True)
                widget.installEventFilter(self)
            except Exception:
                pass

    def eventFilter(self, watched, event):
        """Catch drag/drop on child widgets so Explorer drops work anywhere useful."""
        try:
            event_type = event.type()
            if event_type == QEvent.Type.DragEnter:
                if self._dropped_local_paths(event.mimeData()):
                    event.setDropAction(Qt.DropAction.CopyAction)
                    event.accept()
                    return True
            elif event_type == QEvent.Type.DragMove:
                if self._dropped_local_paths(event.mimeData()):
                    event.setDropAction(Qt.DropAction.CopyAction)
                    event.accept()
                    return True
            elif event_type == QEvent.Type.Drop:
                if self._dropped_local_paths(event.mimeData()):
                    self.dropEvent(event)
                    return True
        except Exception:
            pass
        return super().eventFilter(watched, event)

    def ensure_buffer_values_folders(self):
        """Ensure BufferValues exists for every game's configured mod root."""
        try:
            mod_paths = settings.get("mod_paths", {})
            for game in GAMES.keys():
                base = mod_paths.get(game, default_mod_paths.get(game))
                if not base:
                    continue
                os.makedirs(os.path.join(base, "BufferValues"), exist_ok=True)
        except Exception as e:
            print(f"Failed to ensure BufferValues folders: {e}")

    def request_mods_refresh(self):
        """Thread-safe request to refresh mods list after filesystem changes."""
        try:
            QMetaObject.invokeMethod(self, "_start_mod_refresh_timer", Qt.ConnectionType.QueuedConnection)
        except Exception:
            try:
                QTimer.singleShot(0, self._start_mod_refresh_timer)
            except Exception:
                pass

    # -------------------- UI --------------------
    def init_ui(self):
        main_layout = QVBoxLayout()
        self.setLayout(main_layout)

        # Top: Game selection + update dot
        top_layout = QHBoxLayout()
        # GameBanana quick link button
        self.gamebanana_btn = QPushButton("GB")
        self.gamebanana_btn.setToolTip("Open selected game's GameBanana page")
        self.gamebanana_btn.setFixedWidth(40)
        self.gamebanana_btn.clicked.connect(self.open_gamebanana)

        self.game_combo = QComboBox()
        for k,v in GAMES.items():
            self.game_combo.addItem(v,k)
        self.game_combo.setCurrentIndex(list(GAMES.keys()).index(self.selected_game))
        self.game_combo.currentIndexChanged.connect(lambda _: self.change_game())

        top_layout.addStretch()
        top_layout.addWidget(QLabel("Select Game:"))
        top_layout.addWidget(self.gamebanana_btn)
        top_layout.addWidget(self.game_combo)

        self.mode_modmanager_btn = QPushButton("Mod Manager")
        self.mode_modmanager_btn.clicked.connect(self.switch_to_modmanager_mode)
        top_layout.addWidget(self.mode_modmanager_btn)
        self.mode_browse_btn = QPushButton("Browse")
        self.mode_browse_btn.clicked.connect(self.switch_to_browse_mode)
        top_layout.addWidget(self.mode_browse_btn)
        
        # Search bar
        top_layout.addWidget(QLabel("  Search:"))
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("Type character name...")
        self.search_input.setMaximumWidth(200)
        self.search_input.textChanged.connect(self.on_search_text_changed)
        top_layout.addWidget(self.search_input)
        
        # Search results list (hidden by default)
        self.search_results_list = QListWidget()
        self.search_results_list.setMaximumHeight(150)
        self.search_results_list.itemClicked.connect(self.on_search_result_selected)
        self.search_results_list.hide()
        # Will be added to layout after main_layout is created

        # Update dot + label (moved next to game selection)
        self.update_dot = QLabel("●")  # colored dot via stylesheet
        self.update_dot.setFixedWidth(12)
        self.update_dot.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.update_dot.setStyleSheet("color: red; font-weight: bold;")
        self.update_label = QLabel("Checking...")
        self.update_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        self.update_label.setMaximumWidth(150)
        # Always show, will update after check
        self.update_dot.setVisible(True)
        self.update_label.setVisible(True)

        top_layout.addSpacing(10)
        top_layout.addWidget(self.update_dot)
        top_layout.addWidget(self.update_label)
        main_layout.addLayout(top_layout)
        
        # Add search results list below top bar
        main_layout.addWidget(self.search_results_list)

        # Main content stack
        self.content_stack = QStackedWidget()

        # Overview page: category tabs
        self.overview_page = QWidget()
        overview_layout = QVBoxLayout()
        overview_layout.setContentsMargins(0, 0, 0, 0)
        self.overview_page.setLayout(overview_layout)

        # Tabs for categories + settings
        self.tab_widget = QTabWidget()
        self.tab_widget.setTabPosition(QTabWidget.TabPosition.West)
        self.tabs = {}
        for cat in CATEGORIES:
            tab = QWidget()
            scroll = QScrollArea()
            scroll.setWidgetResizable(True)
            # Disable horizontal scrolling; only allow vertical
            scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
            scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
            content = QWidget()
            grid = QGridLayout()
            grid.setSpacing(5)
            grid.setContentsMargins(5, 5, 5, 5)
            content.setLayout(grid)
            # Set size policy so content expands horizontally but respects maximum width
            from PyQt6.QtWidgets import QSizePolicy
            content.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
            scroll.setWidget(content)
            layout = QVBoxLayout()
            
            # Add button for characters category
            if cat == "characters":
                # Store as an attribute so theme updates can target it
                self.btn_add_char = QPushButton("➕ Add Character")
                self.btn_add_char.setObjectName("addCharBtn")
                # Minimal default styling; will be overridden by theme application
                self.btn_add_char.setStyleSheet("QPushButton { padding: 8px; border-radius:4px; font-weight:bold; }")
                self.btn_add_char.clicked.connect(self.add_new_character)
                layout.addWidget(self.btn_add_char)
            
            layout.addWidget(scroll)
            tab.setLayout(layout)
            tab_label = "BufferValues" if cat == "buffervalues" else cat.capitalize()
            self.tab_widget.addTab(tab, tab_label)
            self.tabs[cat] = {"tab": tab, "grid": grid, "scroll": scroll, "content": content}

        # Fixes tab (scripts runner)
        self.fixes_tab = QWidget()
        self.fixes_layout = QVBoxLayout()
        self.fixes_tab.setLayout(self.fixes_layout)
        self.tab_widget.addTab(self.fixes_tab, "Fixes")
        self.create_fixes_tab()

        # Settings tab
        self.settings_tab = QWidget()
        self.settings_layout = QVBoxLayout()
        self.settings_tab.setLayout(self.settings_layout)
        self.tab_widget.addTab(self.settings_tab, "Settings")
        self.create_settings_tab()

        self.tab_widget.currentChanged.connect(self.tab_changed)
        overview_layout.addWidget(self.tab_widget)
        self.content_stack.addWidget(self.overview_page)

        self.browse_page = QWidget()
        self.browse_layout = QVBoxLayout()
        self.browse_page.setLayout(self.browse_layout)
        self.create_browse_tab()
        self.content_stack.addWidget(self.browse_page)

        # Detail page: selected character with mods + preview + INI editor
        self.detail_page = QWidget()
        detail_layout = QVBoxLayout()
        detail_layout.setContentsMargins(0, 0, 0, 0)
        self.detail_page.setLayout(detail_layout)

        detail_header = QHBoxLayout()
        self.back_to_overview_btn = QPushButton("<- Back")
        self.back_to_overview_btn.clicked.connect(self.show_overview_screen)
        self.detail_character_label = QLabel("No character selected")
        self.detail_character_label.setStyleSheet("font-size: 16px; font-weight: bold;")
        detail_header.addWidget(self.back_to_overview_btn)
        detail_header.addWidget(self.detail_character_label)
        detail_header.addStretch()
        detail_layout.addLayout(detail_header)

        detail_action_row = QHBoxLayout()
        self.open_folder_btn = QPushButton("Open Character Folder")
        self.open_folder_btn.clicked.connect(self.open_selected_folder)
        self.open_mod_folder_btn = QPushButton("Open Selected Mod Folder")
        self.open_mod_folder_btn.clicked.connect(self.open_selected_mod_folder)
        detail_action_row.addWidget(self.open_folder_btn)
        detail_action_row.addWidget(self.open_mod_folder_btn)
        detail_action_row.addStretch()
        detail_layout.addLayout(detail_action_row)

        detail_body = QHBoxLayout()

        # Left column: mod list and toggles
        mod_column = QVBoxLayout()

        # Enable/Disable button
        self.toggle_mod_btn = QPushButton("Enable/Disable Selected Mod")
        self.toggle_mod_btn.clicked.connect(self.toggle_selected_mod)
        mod_column.addWidget(self.toggle_mod_btn)

        self.mod_list_widget = ModListWidget()
        self.mod_list_widget.setSelectionMode(QListWidget.SelectionMode.SingleSelection)
        self.mod_list_widget.itemClicked.connect(self.select_mod)
        self.mod_list_widget.mod_manager = self
        mod_column.addWidget(self.mod_list_widget, 1)
        detail_body.addLayout(mod_column, 2)

        # Right column: preview and INI editor
        preview_ini_column = QVBoxLayout()

        # ---------- Preview Setup ----------
        self.preview_label = QLabel("No preview available")
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview_label.setFixedHeight(250)  # adjust height as needed
        # Theme-aware preview background/text so light theme remains readable
        theme_mode = settings.get("theme", "dark")
        if theme_mode in ("dark", "game"):
            prev_style = "border: 1px solid gray; background-color: #111; color: #ccc;"
        else:
            prev_style = "border: 1px solid #bbb; background-color: #f5f5f5; color: #222;"
        self.preview_label.setStyleSheet(prev_style)
        self.preview_images = []   # list of image paths
        self.preview_index = 0

        # Create a horizontal layout for preview + buttons
        preview_layout = QHBoxLayout()

        # Left button
        self.prev_img_btn = QPushButton("<")
        self.prev_img_btn.setFixedWidth(30)
        self.prev_img_btn.clicked.connect(self.show_prev_image)
        self.prev_img_btn.setEnabled(False)
        preview_layout.addWidget(self.prev_img_btn, alignment=Qt.AlignmentFlag.AlignVCenter)

        # Preview label in the center
        preview_layout.addWidget(self.preview_label, 1)  # stretch factor 1 for label to expand

        # Right button
        self.next_img_btn = QPushButton(">")
        self.next_img_btn.setFixedWidth(30)
        self.next_img_btn.clicked.connect(self.show_next_image)
        self.next_img_btn.setEnabled(False)
        preview_layout.addWidget(self.next_img_btn, alignment=Qt.AlignmentFlag.AlignVCenter)

        # Add the horizontal layout to the right column
        preview_ini_column.addLayout(preview_layout)

        ini_header = QLabel("Key Binding Editor")
        ini_header.setStyleSheet("font-size: 14px; font-weight: bold;")
        preview_ini_column.addWidget(ini_header)

        self.ini_file_label = QLabel("INI: No file selected")
        self.ini_file_label.setWordWrap(True)
        preview_ini_column.addWidget(self.ini_file_label)

        key_label = QLabel("Sections:")
        preview_ini_column.addWidget(key_label)
        self.ini_key_list = QListWidget()
        self.ini_key_list.setMaximumHeight(160)
        self.ini_key_list.currentRowChanged.connect(self.on_ini_key_changed)
        preview_ini_column.addWidget(self.ini_key_list)

        fwd_row = QHBoxLayout()
        fwd_row.addWidget(QLabel("Forward Key:"))
        self.ini_value_input = QLineEdit()
        self.ini_value_input.setPlaceholderText("e.g. VK_NUMPAD1")
        fwd_row.addWidget(self.ini_value_input, 1)
        preview_ini_column.addLayout(fwd_row)

        back_row = QHBoxLayout()
        back_row.addWidget(QLabel("Backward Key:"))
        self.ini_back_input = QLineEdit()
        self.ini_back_input.setPlaceholderText("e.g. h  (leave empty to remove)")
        back_row.addWidget(self.ini_back_input, 1)
        preview_ini_column.addLayout(back_row)

        self.ini_status_label = QLabel("Select a mod to load key bindings.")
        self.ini_status_label.setWordWrap(True)
        preview_ini_column.addWidget(self.ini_status_label)

        self.ini_save_btn = QPushButton("Save Key Binding")
        self.ini_save_btn.clicked.connect(self.save_ini_value)
        self.ini_save_btn.setEnabled(False)
        preview_ini_column.addWidget(self.ini_save_btn)
        preview_ini_column.addStretch()

        detail_body.addLayout(preview_ini_column, 3)
        detail_layout.addLayout(detail_body)
        self.content_stack.addWidget(self.detail_page)

        main_layout.addWidget(self.content_stack)
        self.switch_to_modmanager_mode()
        self.apply_theme()

    # -------------------- BROWSE TAB --------------------
    def switch_to_modmanager_mode(self):
        self.content_stack.setCurrentWidget(self.overview_page)
        try:
            self.mode_modmanager_btn.setEnabled(False)
            self.mode_browse_btn.setEnabled(True)
            self.search_input.setEnabled(True)
        except Exception:
            pass

    def switch_to_browse_mode(self):
        self.content_stack.setCurrentWidget(self.browse_page)
        try:
            self.mode_modmanager_btn.setEnabled(True)
            self.mode_browse_btn.setEnabled(False)
            self.search_input.setEnabled(False)
        except Exception:
            pass
        if not self.browse_type_combo.count():
            self.initialize_browse_for_game()

    def create_browse_tab(self):
        controls = QHBoxLayout()
        self.browse_game_label = QLabel()
        controls.addWidget(self.browse_game_label)
        controls.addStretch()
        controls.addWidget(QLabel("Target:"))
        self.browse_target_label = QLabel("No character selected")
        self.browse_target_label.setMaximumWidth(260)
        controls.addWidget(self.browse_target_label)
        self.browse_open_game_btn = QPushButton("Open GameBanana")
        self.browse_open_game_btn.clicked.connect(self.open_gamebanana)
        controls.addWidget(self.browse_open_game_btn)
        self.browse_layout.addLayout(controls)

        filter_row = QHBoxLayout()
        filter_row.addWidget(QLabel("Search:"))
        self.browse_search_input = QLineEdit()
        self.browse_search_input.setPlaceholderText("Search GameBanana mods")
        self.browse_search_input.returnPressed.connect(self.refresh_browse_mods)
        filter_row.addWidget(self.browse_search_input, 1)
        self.browse_search_btn = QPushButton("Search")
        self.browse_search_btn.clicked.connect(self.refresh_browse_mods)
        filter_row.addWidget(self.browse_search_btn)
        self.browse_clear_search_btn = QPushButton("Clear")
        self.browse_clear_search_btn.clicked.connect(self.clear_browse_search)
        filter_row.addWidget(self.browse_clear_search_btn)
        filter_row.addWidget(QLabel("Type:"))
        self.browse_type_combo = QComboBox()
        self.browse_type_combo.currentIndexChanged.connect(self.on_browse_type_changed)
        filter_row.addWidget(self.browse_type_combo)
        filter_row.addWidget(QLabel("Sort:"))
        self.browse_sort_combo = QComboBox()
        for label, value in BROWSE_SORTS:
            self.browse_sort_combo.addItem(label, value)
        self.browse_sort_combo.currentIndexChanged.connect(lambda _: self.refresh_browse_mods())
        filter_row.addWidget(self.browse_sort_combo)
        self.browse_layout.addLayout(filter_row)

        body = QHBoxLayout()

        left_col = QVBoxLayout()
        left_col.addWidget(QLabel("Categories"))
        self.browse_category_list = QListWidget()
        self.browse_category_list.itemClicked.connect(self.on_browse_category_selected)
        left_col.addWidget(self.browse_category_list, 1)
        body.addLayout(left_col, 1)

        center_col = QVBoxLayout()
        self.browse_cards_scroll = QScrollArea()
        self.browse_cards_scroll.setWidgetResizable(True)
        self.browse_cards_content = QWidget()
        self.browse_cards_grid = QGridLayout()
        self.browse_cards_grid.setContentsMargins(8, 8, 8, 8)
        self.browse_cards_grid.setSpacing(8)
        self.browse_cards_grid.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        self.browse_cards_content.setLayout(self.browse_cards_grid)
        self.browse_cards_scroll.setWidget(self.browse_cards_content)
        center_col.addWidget(self.browse_cards_scroll, 1)
        self.browse_load_more_btn = QPushButton("Load More")
        self.browse_load_more_btn.clicked.connect(self.load_more_browse)
        self.browse_load_more_btn.setEnabled(False)
        center_col.addWidget(self.browse_load_more_btn)
        body.addLayout(center_col, 3)

        right_col = QVBoxLayout()
        self.browse_detail_preview = QLabel("No preview")
        self.browse_detail_preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.browse_detail_preview.setFixedHeight(220)
        self.browse_detail_preview.setStyleSheet("border: 1px solid #555; background-color: #111;")
        right_col.addWidget(self.browse_detail_preview)

        self.browse_mod_info_label = QLabel("Select a mod.")
        self.browse_mod_info_label.setWordWrap(True)
        right_col.addWidget(self.browse_mod_info_label)

        self.browse_description = QTextEdit()
        self.browse_description.setReadOnly(True)
        self.browse_description.setMaximumHeight(180)
        right_col.addWidget(self.browse_description)

        self.browse_open_profile_btn = QPushButton("Open Mod Page")
        self.browse_open_profile_btn.setEnabled(False)
        self.browse_open_profile_btn.clicked.connect(self.open_selected_browse_profile)
        right_col.addWidget(self.browse_open_profile_btn)

        right_col.addWidget(QLabel("Files"))
        self.browse_files_list = QListWidget()
        self.browse_files_list.itemClicked.connect(self.on_browse_file_selected)
        self.browse_files_list.setMaximumHeight(150)
        right_col.addWidget(self.browse_files_list)

        self.browse_install_btn = QPushButton("Queue Download + Install")
        self.browse_install_btn.setEnabled(False)
        self.browse_install_btn.clicked.connect(self.enqueue_selected_browse_download)
        right_col.addWidget(self.browse_install_btn)

        self.browse_progress = QProgressBar()
        self.browse_progress.setRange(0, 100)
        self.browse_progress.setValue(0)
        right_col.addWidget(self.browse_progress)

        right_col.addWidget(QLabel("Downloads"))
        self.browse_downloads_list = QListWidget()
        self.browse_downloads_list.setMaximumHeight(180)
        right_col.addWidget(self.browse_downloads_list)

        self.browse_status_label = QLabel("Loading browse data...")
        self.browse_status_label.setWordWrap(True)
        right_col.addWidget(self.browse_status_label)
        body.addLayout(right_col, 2)

        self.browse_layout.addLayout(body)
        self.initialize_browse_for_game()

    def initialize_browse_for_game(self):
        cfg = BROWSE_GAME_DATA.get(self.selected_game)
        self.browse_game_label.setText(f"Browse: {GAMES.get(self.selected_game, self.selected_game)}")
        self.update_browse_target_label()
        self.browse_type_combo.blockSignals(True)
        self.browse_type_combo.clear()
        if cfg:
            for entry in cfg.get("types", []):
                self.browse_type_combo.addItem(entry["name"], entry)
        self.browse_type_combo.blockSignals(False)
        self.browse_search_input.clear()
        self.browse_description.clear()
        self.browse_status_label.setText("Loading categories...")
        self.browse_open_profile_btn.setEnabled(False)
        self.browse_install_btn.setEnabled(False)
        self.browse_progress.setValue(0)
        self.browse_selected_mod = None
        self.browse_selected_file = None
        self.browse_selected_index = -1
        self.browse_results_data = []
        self.browse_category_list.clear()
        self._clear_browse_cards()
        self._refresh_browse_downloads_list()
        if self.browse_type_combo.count():
            self.on_browse_type_changed(self.browse_type_combo.currentIndex())

    def update_browse_target_label(self):
        if self.selected_item:
            category_name = (self.selected_category or "").capitalize()
            item_name = self.selected_item.get("name", "Unknown")
            self.browse_target_label.setText(f"{category_name}: {item_name}")
        else:
            self.browse_target_label.setText("No destination selected")

    def on_browse_type_changed(self, index):
        entry = self.browse_type_combo.itemData(index)
        self.browse_selected_type = entry
        # Type changes should apply immediately; do not keep stale text-search route active.
        self.browse_search_input.clear()
        self.browse_category_list.clear()
        home_item = QListWidgetItem("Featured")
        home_item.setData(Qt.ItemDataRole.UserRole, {"mode": "home", "id": None, "name": "Featured"})
        self.browse_category_list.addItem(home_item)
        if not entry:
            return
        token = self._next_browse_token()
        self.browse_categories_token = token
        self.browse_status_label.setText("Loading categories...")
        threading.Thread(target=self._browse_load_categories_worker, args=(token, entry), daemon=True).start()

    def on_browse_category_selected(self, item):
        data = item.data(Qt.ItemDataRole.UserRole) or {}
        mode = data.get("mode", "category")
        name = data.get("name", "")
        if mode == "home":
            self.browse_route = ("home", None)
        else:
            self.browse_route = ("category", {"id": data.get("id"), "name": name})
        self.refresh_browse_mods()

    def refresh_browse_mods(self, force_route=None):
        if force_route is not None:
            self.browse_route = force_route
        else:
            query = (self.browse_search_input.text() or "").strip()
            if query:
                self.browse_route = ("search", query)
            elif self.browse_route[0] == "search":
                self.browse_route = ("home", None)
        self._start_browse_route_load(reset=True)

    def clear_browse_search(self):
        self.browse_search_input.clear()
        self.refresh_browse_mods()

    def load_more_browse(self):
        if self.browse_loading or not self.browse_has_more:
            return
        self._start_browse_route_load(reset=False)

    def _start_browse_route_load(self, reset=False):
        if self.browse_loading:
            return
        if reset:
            self.browse_current_page = 1
            self.browse_has_more = False
            self.browse_results_data = []
            self.browse_selected_mod = None
            self.browse_selected_file = None
            self.browse_selected_index = -1
            self._clear_browse_cards()
            self.browse_files_list.clear()
            self.browse_description.clear()
            self.browse_detail_preview.setPixmap(QPixmap())
            self.browse_detail_preview.setText("No preview")
            self.browse_mod_info_label.setText("Loading mods...")
            self.browse_open_profile_btn.setEnabled(False)
            self.browse_install_btn.setEnabled(False)
        self.browse_loading = True
        self.browse_load_more_btn.setEnabled(False)
        token = self._next_browse_token()
        self.browse_mods_token = token
        page = self.browse_current_page if not reset else 1
        threading.Thread(target=self._browse_load_mods_worker, args=(token, page, self.browse_route), daemon=True).start()

    def _next_browse_token(self):
        self.browse_request_token += 1
        return self.browse_request_token

    def _browse_api_json(self, endpoint, timeout=30):
        if endpoint.startswith("http://") or endpoint.startswith("https://"):
            url = endpoint
        else:
            url = "https://gamebanana.com/apiv11/" + endpoint.lstrip("/")
        req = urllib.request.Request(url, headers={"User-Agent": "ModManager-Browse"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="ignore"))

    def _normalize_records(self, payload):
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            for key in ("_aRecords", "records", "_aData", "data", "_aItems", "items"):
                value = payload.get(key)
                if isinstance(value, list):
                    return value
            values = list(payload.values())
            if values and all(isinstance(v, dict) for v in values):
                return values
        return []

    def _extract_preview_url(self, rec):
        media = rec.get("_aPreviewMedia") if isinstance(rec, dict) else None
        images = None
        if isinstance(media, dict):
            images = media.get("_aImages")
            if images is None:
                values = list(media.values())
                if values and isinstance(values[0], list):
                    images = values[0]
                elif isinstance(values, list):
                    images = values
        elif isinstance(media, list):
            images = media
        if isinstance(images, list):
            for img in images:
                if not isinstance(img, dict):
                    continue
                base = img.get("_sBaseUrl") or ""
                for key in ("_sFile530", "_sFile220", "_sFile100", "_sFile"):
                    file_name = img.get(key)
                    if base and file_name:
                        return f"{base}/{file_name}"
                for key in ("_sUrl", "url"):
                    url = img.get(key)
                    if url:
                        return url
        for key in ("_sPreviewUrl", "preview", "thumbnail"):
            url = rec.get(key) if isinstance(rec, dict) else None
            if url:
                return url
        return None

    def _extract_file_entries(self, rec):
        files = rec.get("_aFiles") if isinstance(rec, dict) else None
        if isinstance(files, dict):
            files = list(files.values())
        result = []
        if isinstance(files, list):
            for file_entry in files:
                if not isinstance(file_entry, dict):
                    continue
                url = file_entry.get("_sDownloadUrl") or file_entry.get("_sUrl") or file_entry.get("url")
                if isinstance(url, str) and url:
                    if url.startswith("/"):
                        url = "https://gamebanana.com" + url
                    result.append({
                        "id": file_entry.get("_idRow"),
                        "name": file_entry.get("_sFile") or file_entry.get("_sName") or "download",
                        "size": file_entry.get("_nFilesize") or 0,
                        "url": url,
                    })
        return result

    def _html_to_text(self, value):
        if not value:
            return ""
        text = re.sub(r"<br\s*/?>", "\n", str(value), flags=re.IGNORECASE)
        text = re.sub(r"</p\s*>", "\n\n", text, flags=re.IGNORECASE)
        text = re.sub(r"<[^>]+>", "", text)
        return html.unescape(text).strip()

    def _browse_load_categories_worker(self, token, type_entry):
        try:
            rows = self._browse_api_json(
                f"Mod/Categories?_idCategoryRow={type_entry['id']}&_sSort=a_to_z&_bShowEmpty=true",
                timeout=20,
            )
            records = self._normalize_records(rows)
            cats = []
            if isinstance(records, list):
                for rec in records:
                    if not isinstance(rec, dict):
                        continue
                    cats.append({
                        "id": rec.get("_idRow"),
                        "name": rec.get("_sName") or "Unnamed",
                    })
            self.browse_message_queue.put(("categories_loaded", token, type_entry, cats))
        except Exception as e:
            self.browse_message_queue.put(("categories_error", token, type_entry, str(e)))

    def _browse_load_mods_worker(self, token, page, route):
        try:
            cfg = BROWSE_GAME_DATA.get(self.selected_game) or {}
            game_id = cfg.get("game_id", "")
            if not game_id:
                raise RuntimeError("No GameBanana game id configured for selected game")

            raw_sort = self.browse_sort_combo.currentData() if hasattr(self, "browse_sort_combo") else "default"
            sort_map = {
                "new": "new",
                "updated": "updated",
                "popular": "hot",
            }
            sort_value = sort_map.get(raw_sort)

            if route[0] == "search":
                term = quote(str(route[1] or ""))
                endpoint = f"Util/Search/Results?_sModelName=Mod&_sOrder=best_match&_idGameRow={game_id}&_sSearchString={term}&_nPage={page}"
            elif route[0] == "category":
                cat_id = (route[1] or {}).get("id")
                if not cat_id and self.browse_selected_type:
                    cat_id = self.browse_selected_type.get("id")
                if not cat_id:
                    raise RuntimeError("No category selected")
                params = [
                    ("_nPerpage", "15"),
                    ("_aFilters[Generic_Category]", str(cat_id)),
                    ("_nPage", str(page)),
                ]
                if sort_value:
                    params.append(("_sSort", sort_value))
                endpoint = f"Mod/Index?{urlencode(params)}"
            else:
                params = [
                    ("_csvModelInclusions", "Mod"),
                    ("_nPage", str(page)),
                ]
                if sort_value:
                    params.append(("_sSort", sort_value))
                endpoint = f"Game/{game_id}/Subfeed?{urlencode(params)}"
            payload = self._browse_api_json(endpoint, timeout=30)
            records = self._normalize_records(payload)
            items = []
            for rec in records:
                if not isinstance(rec, dict):
                    continue
                model_name = (rec.get("_sModelName") or "Mod").lower()
                if model_name not in ("mod", ""):
                    continue
                mod_id = rec.get("_idRow") or rec.get("id")
                if not mod_id:
                    continue
                submitter = rec.get("_aSubmitter") or rec.get("_sSubmitter") or rec.get("_sOwnerName") or "Unknown"
                if isinstance(submitter, dict):
                    submitter = submitter.get("_sName") or submitter.get("name") or "Unknown"
                items.append({
                    "id": mod_id,
                    "route": f"Mod/{mod_id}",
                    "name": rec.get("_sName") or "Unnamed Mod",
                    "profile": rec.get("_sProfileUrl") or f"https://gamebanana.com/mods/{mod_id}",
                    "preview": self._extract_preview_url(rec),
                    "submitter": str(submitter),
                    "summary": self._html_to_text(rec.get("_sText") or rec.get("_sDescription") or ""),
                    "files": [],
                })
            self.browse_message_queue.put(("mods_loaded", token, page, items, len(items) >= 15))
        except Exception as e:
            self.browse_message_queue.put(("mods_error", token, str(e)))

    def _browse_load_details_worker(self, token, route):
        try:
            payload = self._browse_api_json(f"{route}/ProfilePage", timeout=30)
            detail = {
                "route": route,
                "description": self._html_to_text(payload.get("_sText") or payload.get("_sDescription") or ""),
                "files": self._extract_file_entries(payload),
                "preview": self._extract_preview_url(payload),
                "profile": payload.get("_sProfileUrl") or f"https://gamebanana.com/{route.replace('Mod', 'mods')}",
                "submitter": payload.get("_aSubmitter", {}),
            }
            self.browse_message_queue.put(("detail_loaded", token, detail))
        except Exception as e:
            self.browse_message_queue.put(("detail_error", token, route, str(e)))

    def _browse_image_worker(self, idx, url):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ModManager-Browse"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
            if data:
                self.browse_preview_cache[url] = data
                self.browse_message_queue.put(("thumb_loaded", idx, url, data))
        except Exception:
            pass

    def _process_browse_queue(self):
        processed = 0
        while not self.browse_message_queue.empty() and processed < 30:
            try:
                msg = self.browse_message_queue.get_nowait()
            except Exception:
                break
            kind = msg[0]
            if kind == "categories_loaded":
                _, token, type_entry, cats = msg
                if token != self.browse_categories_token:
                    processed += 1
                    continue
                self.browse_category_list.clear()
                featured = QListWidgetItem("Featured")
                featured.setData(Qt.ItemDataRole.UserRole, {"mode": "home", "id": None, "name": "Featured"})
                self.browse_category_list.addItem(featured)
                all_type = QListWidgetItem(f"All {type_entry['name']}")
                all_type.setData(Qt.ItemDataRole.UserRole, {"mode": "category", "id": type_entry["id"], "name": type_entry["name"]})
                self.browse_category_list.addItem(all_type)
                default_route = ("category", {"id": type_entry["id"], "name": type_entry["name"]})
                if cats:
                    for cat in cats:
                        item = QListWidgetItem(cat["name"])
                        item.setData(Qt.ItemDataRole.UserRole, {"mode": "category", "id": cat["id"], "name": cat["name"]})
                        self.browse_category_list.addItem(item)
                else:
                    pass
                self.browse_category_list.setCurrentRow(1)
                self.refresh_browse_mods(force_route=default_route)
            elif kind == "categories_error":
                _, token, type_entry, err = msg
                if token != self.browse_categories_token:
                    processed += 1
                    continue
                self.browse_category_list.clear()
                featured = QListWidgetItem("Featured")
                featured.setData(Qt.ItemDataRole.UserRole, {"mode": "home", "id": None, "name": "Featured"})
                self.browse_category_list.addItem(featured)
                all_type = QListWidgetItem(f"All {type_entry['name']}")
                all_type.setData(Qt.ItemDataRole.UserRole, {"mode": "category", "id": type_entry["id"], "name": type_entry["name"]})
                self.browse_category_list.addItem(all_type)
                self.browse_status_label.setText(f"Category fallback in use: {err}")
                self.browse_category_list.setCurrentRow(1)
                self.refresh_browse_mods(force_route=("category", {"id": type_entry["id"], "name": type_entry["name"]}))
            elif kind == "mods_loaded":
                _, token, page, items, has_more = msg
                if token != self.browse_mods_token:
                    processed += 1
                    continue
                self.browse_loading = False
                self.browse_has_more = has_more
                self.browse_load_more_btn.setEnabled(has_more)
                start_idx = len(self.browse_results_data)
                self.browse_results_data.extend(items)
                self.browse_current_page = page + 1
                self.render_browse_cards()
                self.browse_status_label.setText(f"Loaded {len(self.browse_results_data)} mod(s).")
                if start_idx == 0 and self.browse_results_data:
                    self.select_browse_mod_by_index(0)
            elif kind == "mods_error":
                _, token, err = msg
                if token != self.browse_mods_token:
                    processed += 1
                    continue
                self.browse_loading = False
                self.browse_has_more = False
                self.browse_load_more_btn.setEnabled(False)
                self.browse_status_label.setText(f"Browse error: {err}")
            elif kind == "detail_loaded":
                _, token, detail = msg
                mod = self.browse_selected_mod
                if not mod or token != self.browse_detail_token or detail.get("route") != mod.get("route"):
                    processed += 1
                    continue
                mod["files"] = detail.get("files", [])
                mod["profile"] = detail.get("profile") or mod.get("profile")
                if detail.get("preview"):
                    mod["preview"] = detail.get("preview")
                description = detail.get("description") or mod.get("summary") or ""
                self.browse_description.setPlainText(description or "No description.")
                self.browse_files_list.clear()
                for file_entry in mod.get("files", []):
                    self.browse_files_list.addItem(file_entry.get("name", "download"))
                self.browse_status_label.setText(f"Found {len(mod.get('files', []))} file(s).")
                self._update_browse_detail_preview(mod.get("preview"))
            elif kind == "detail_error":
                _, token, route, err = msg
                mod = self.browse_selected_mod
                if mod and token == self.browse_detail_token and route == mod.get("route"):
                    self.browse_description.setPlainText(mod.get("summary") or "No description.")
                    self.browse_status_label.setText(f"Detail load failed: {err}")
            elif kind == "thumb_loaded":
                _, idx, url, data = msg
                if idx < len(self.browse_card_img_labels):
                    pix = QPixmap()
                    if pix.loadFromData(data):
                        self.browse_card_img_labels[idx].setPixmap(
                            pix.scaled(190, 105, Qt.AspectRatioMode.KeepAspectRatioByExpanding, Qt.TransformationMode.SmoothTransformation)
                        )
                        self.browse_card_img_labels[idx].setText("")
                if self.browse_selected_mod and self.browse_selected_mod.get("preview") == url:
                    self._update_browse_detail_preview(url)
            elif kind == "download_progress":
                _, item_id, pct, text = msg
                if self.browse_download_current and self.browse_download_current.get("id") == item_id:
                    self.browse_progress.setValue(max(0, min(100, pct)))
                    self.browse_status_label.setText(text)
                    self.browse_download_current["status"] = text
                    self._refresh_browse_downloads_list()
            elif kind == "download_complete":
                _, item_id, install_path = msg
                if self.browse_download_current and self.browse_download_current.get("id") == item_id:
                    self.browse_download_current["state"] = "completed"
                    self.browse_download_current["status"] = f"Installed to {install_path}"
                    self.browse_download_history.insert(0, dict(self.browse_download_current))
                    self.browse_download_current = None
                    self.browse_progress.setValue(100)
                    self.browse_status_label.setText(f"Installed: {install_path}")
                    self.load_mods()
                    self._refresh_browse_downloads_list()
                    self._start_next_browse_download()
            elif kind == "download_failed":
                _, item_id, err = msg
                if self.browse_download_current and self.browse_download_current.get("id") == item_id:
                    self.browse_download_current["state"] = "failed"
                    self.browse_download_current["status"] = err
                    self.browse_download_history.insert(0, dict(self.browse_download_current))
                    self.browse_download_current = None
                    self.browse_progress.setValue(0)
                    self.browse_status_label.setText(err)
                    self._refresh_browse_downloads_list()
                    self._start_next_browse_download()
            processed += 1

    def _clear_browse_cards(self):
        for i in reversed(range(self.browse_cards_grid.count())):
            item = self.browse_cards_grid.itemAt(i)
            widget = item.widget() if item else None
            if widget:
                widget.setParent(None)
        self.browse_card_frames = []
        self.browse_card_img_labels = []

    def _browse_card_style(self, selected=False):
        if selected:
            return "QFrame{border:2px solid #d4af37;border-radius:8px;background:#262626;}"
        return "QFrame{border:1px solid #555;border-radius:8px;background:#1f1f1f;}QFrame:hover{border:1px solid #d4af37;}"

    def _update_browse_card_selection(self):
        for idx, frame in enumerate(self.browse_card_frames):
            try:
                frame.setStyleSheet(self._browse_card_style(idx == self.browse_selected_index))
            except Exception:
                pass

    def _browse_columns(self):
        try:
            avail = self.browse_cards_scroll.viewport().width()
        except Exception:
            avail = 700
        card_w = 205
        cols = max(1, int(avail // card_w))
        return cols

    def render_browse_cards(self, start_idx=0):
        del start_idx
        self._clear_browse_cards()
        cols = self._browse_columns()
        row = 0
        col = 0
        for idx in range(0, len(self.browse_results_data)):
            data = self.browse_results_data[idx]
            frame = QFrame()
            frame.setFrameShape(QFrame.Shape.Box)
            frame.setStyleSheet(self._browse_card_style(False))
            layout = QVBoxLayout(frame)
            layout.setContentsMargins(4, 4, 4, 4)
            layout.setSpacing(4)

            img = QLabel("...")
            img.setFixedSize(190, 105)
            img.setAlignment(Qt.AlignmentFlag.AlignCenter)
            img.setStyleSheet("background:#111;color:#777;")
            cached = self.browse_preview_cache.get(data.get("preview"))
            if cached:
                pix = QPixmap()
                if pix.loadFromData(cached):
                    img.setPixmap(pix.scaled(190, 105, Qt.AspectRatioMode.KeepAspectRatioByExpanding, Qt.TransformationMode.SmoothTransformation))
                    img.setText("")
            layout.addWidget(img)

            name = QLabel(data.get("name", ""))
            name.setWordWrap(True)
            name.setMaximumHeight(40)
            layout.addWidget(name)

            author = QLabel(f"by {data.get('submitter', 'Unknown')}")
            author.setStyleSheet("color:#b5b5b5;font-size:11px;")
            layout.addWidget(author)

            frame.mousePressEvent = lambda e, i=idx: self.select_browse_mod_by_index(i)
            self.browse_cards_grid.addWidget(frame, row, col)
            self.browse_card_frames.append(frame)
            self.browse_card_img_labels.append(img)

            preview_url = data.get("preview")
            if preview_url and preview_url not in self.browse_preview_cache:
                threading.Thread(target=self._browse_image_worker, args=(idx, preview_url), daemon=True).start()

            col += 1
            if col >= cols:
                col = 0
                row += 1
        self._update_browse_card_selection()

    def select_browse_mod_by_index(self, idx):
        if idx < 0 or idx >= len(self.browse_results_data):
            return
        self.browse_selected_index = idx
        self._update_browse_card_selection()
        mod = self.browse_results_data[idx]
        self.browse_selected_mod = mod
        self.browse_selected_file = None
        self.browse_install_btn.setEnabled(False)
        self.browse_open_profile_btn.setEnabled(bool(mod.get("profile")))
        self.browse_mod_info_label.setText(
            f"{mod.get('name', 'Unnamed Mod')}\nby {mod.get('submitter', 'Unknown')}\n{mod.get('profile', '')}"
        )
        self.browse_description.setPlainText(mod.get("summary") or "Loading details...")
        self.browse_files_list.clear()
        self._update_browse_detail_preview(mod.get("preview"))
        token = self._next_browse_token()
        self.browse_detail_token = token
        threading.Thread(target=self._browse_load_details_worker, args=(token, mod.get("route")), daemon=True).start()

    def _update_browse_detail_preview(self, preview_url):
        if not preview_url:
            self.browse_detail_preview.setPixmap(QPixmap())
            self.browse_detail_preview.setText("No preview")
            return
        data = self.browse_preview_cache.get(preview_url)
        if not data:
            self.browse_detail_preview.setPixmap(QPixmap())
            self.browse_detail_preview.setText("Loading preview...")
            threading.Thread(target=self._browse_image_worker, args=(self.browse_selected_index, preview_url), daemon=True).start()
            return
        pix = QPixmap()
        if pix.loadFromData(data):
            self.browse_detail_preview.setPixmap(
                pix.scaled(520, 220, Qt.AspectRatioMode.KeepAspectRatioByExpanding, Qt.TransformationMode.SmoothTransformation)
            )
            self.browse_detail_preview.setText("")
        else:
            self.browse_detail_preview.setPixmap(QPixmap())
            self.browse_detail_preview.setText("No preview")

    def on_browse_file_selected(self, item):
        if not item or not self.browse_selected_mod:
            return
        row = self.browse_files_list.row(item)
        files = self.browse_selected_mod.get("files", [])
        if row < 0 or row >= len(files):
            return
        self.browse_selected_file = files[row]
        self.browse_install_btn.setEnabled(self.selected_item is not None)

    def open_selected_browse_profile(self):
        if not self.browse_selected_mod:
            return
        url = self.browse_selected_mod.get("profile")
        if url:
            webbrowser.open(url)

    def enqueue_selected_browse_download(self):
        if not self.selected_item:
            QMessageBox.warning(self, "Select Destination", "Select a destination folder (character/UI/weapon/NPC/etc.) first.")
            return
        if not self.browse_selected_mod or not self.browse_selected_file:
            QMessageBox.warning(self, "Select File", "Select a mod file to install.")
            return
        self.browse_download_counter += 1
        file_entry = self.browse_selected_file
        item = {
            "id": self.browse_download_counter,
            "state": "queued",
            "status": "Queued",
            "mod_name": self.browse_selected_mod.get("name", "Mod"),
            "file_name": file_entry.get("name", "download"),
            "url": file_entry.get("url"),
            "preview": self.browse_selected_mod.get("preview"),
            "game": self.selected_game,
            "dest_category": self.selected_category,
            "dest_id": self.selected_item.get("id"),
            "dest_name": self.selected_item.get("name", "Unknown"),
        }
        self.browse_download_queue.append(item)
        self._refresh_browse_downloads_list()
        self.browse_status_label.setText(f"Queued: {item['mod_name']}")
        self._start_next_browse_download()

    def _refresh_browse_downloads_list(self):
        self.browse_downloads_list.clear()
        if self.browse_download_current:
            current = self.browse_download_current
            self.browse_downloads_list.addItem(f"[ACTIVE] {current['mod_name']} - {current['status']}")
        for item in self.browse_download_queue:
            self.browse_downloads_list.addItem(f"[QUEUE] {item['mod_name']} - {item['file_name']}")
        for item in self.browse_download_history[:8]:
            label = "OK" if item.get("state") == "completed" else "FAIL"
            self.browse_downloads_list.addItem(f"[{label}] {item['mod_name']} - {item.get('status', '')}")

    def _start_next_browse_download(self):
        if self.browse_download_current or not self.browse_download_queue:
            return
        self.browse_download_current = self.browse_download_queue.pop(0)
        self.browse_download_current["state"] = "downloading"
        self.browse_download_current["status"] = "Downloading"
        self.browse_progress.setValue(0)
        self._refresh_browse_downloads_list()
        threading.Thread(target=self._browse_download_worker, args=(dict(self.browse_download_current),), daemon=True).start()

    def _safe_mod_folder_name(self, value):
        cleaned = re.sub(r'[\\/:*?"<>|]+', "_", value or "mod")
        cleaned = cleaned.strip().strip(".")
        return cleaned or "mod"

    def _extract_archive(self, archive_path, out_dir):
        ext = os.path.splitext(archive_path)[1].lower()
        if ext == ".zip":
            with zipfile.ZipFile(archive_path, "r") as zf:
                zf.extractall(out_dir)
            return
        if ext in (".rar", ".7z"):
            seven_zip = shutil.which("7z") or shutil.which("7za") or shutil.which("7zr")
            if not seven_zip:
                raise RuntimeError("7z is required to extract RAR/7z archives.")
            result = subprocess.run([seven_zip, "x", archive_path, f"-o{out_dir}", "-y"], capture_output=True, text=True)
            if result.returncode != 0:
                raise RuntimeError(result.stderr or result.stdout or "Extract failed")
            return
        raise RuntimeError(f"Unsupported archive type: {ext}")

    def _browse_download_worker(self, item):
        try:
            target_root = os.path.join(
                settings["mod_paths"].get(item["game"], default_mod_paths[item["game"]]),
            )
            target_root = build_item_folder_path(target_root, item["dest_category"], item.get("dest_id"))
            os.makedirs(target_root, exist_ok=True)
            base_name = self._safe_mod_folder_name(item["mod_name"])
            target_path = os.path.join(target_root, base_name)
            copy_idx = 1
            while os.path.exists(target_path):
                target_path = os.path.join(target_root, f"{base_name}_copy{copy_idx}")
                copy_idx += 1

            with tempfile.TemporaryDirectory() as temp_dir:
                archive_name = os.path.basename(item["file_name"]) or "download.zip"
                archive_path = os.path.join(temp_dir, archive_name)

                def progress(downloaded, total):
                    pct = int(downloaded * 100 / total) if total else 0
                    self.browse_message_queue.put((
                        "download_progress",
                        item["id"],
                        pct,
                        f"Downloading {item['mod_name']} ({pct}%)",
                    ))

                if not download_url_to_path(item["url"], archive_path, progress_callback=progress):
                    raise RuntimeError("Download failed")

                self.browse_message_queue.put(("download_progress", item["id"], 100, "Extracting archive"))
                extract_dir = os.path.join(temp_dir, "extract")
                os.makedirs(extract_dir, exist_ok=True)
                self._extract_archive(archive_path, extract_dir)

                entries = [os.path.join(extract_dir, name) for name in os.listdir(extract_dir)]
                if len(entries) == 1 and os.path.isdir(entries[0]):
                    shutil.copytree(entries[0], target_path)
                else:
                    os.makedirs(target_path, exist_ok=True)
                    for entry in entries:
                        dest = os.path.join(target_path, os.path.basename(entry))
                        if os.path.isdir(entry):
                            shutil.copytree(entry, dest)
                        else:
                            shutil.copy2(entry, dest)

                if item.get("preview"):
                    self.save_preview_image_for_installed_mod(item["preview"], target_path)

            self.browse_message_queue.put(("download_complete", item["id"], target_path))
        except Exception as e:
            self.browse_message_queue.put(("download_failed", item["id"], str(e)))

    # -------------------- SETTINGS TAB --------------------
    def create_settings_tab(self):
        # Mod path labels & change buttons
        self.path_labels = {}
        for game, name in GAMES.items():
            label = QLabel(f"{name}: {settings['mod_paths'].get(game, '')}")
            btn = QPushButton("Change Path")
            btn.clicked.connect(lambda _, g=game: self.change_mod_path(g))
            row = QHBoxLayout()
            row.addWidget(label)
            row.addWidget(btn)
            self.settings_layout.addLayout(row)
            self.path_labels[game] = label

        # Theme dropdown
        theme_layout = QHBoxLayout()
        theme_label = QLabel("Theme:")
        self.theme_combo = QComboBox()
        self.theme_combo.addItems(["Dark", "Light", "Game Theme"])
        current_theme = settings.get("theme", "dark")
        if current_theme == "dark":
            self.theme_combo.setCurrentIndex(0)
        elif current_theme == "light":
            self.theme_combo.setCurrentIndex(1)
        else:  # game theme
            self.theme_combo.setCurrentIndex(2)
        self.theme_combo.currentTextChanged.connect(self.on_theme_changed)
        theme_layout.addWidget(theme_label)
        theme_layout.addWidget(self.theme_combo)
        theme_layout.addStretch()
        self.settings_layout.addLayout(theme_layout)

        # Auto-check updates checkbox
        self.auto_check_box = QCheckBox("Auto check for updates on startup")
        self.auto_check_box.setChecked(settings.get("auto_check_updates", False))
        self.auto_check_box.stateChanged.connect(self.toggle_auto_check)
        self.settings_layout.addWidget(self.auto_check_box)

        # Right-click toggle mods
        self.right_click_toggle_box = QCheckBox("Right-click toggles enable/disable mods")
        self.right_click_toggle_box.setChecked(settings.get("right_click_toggle_mods", False))
        def _rc_changed(state):
            settings['right_click_toggle_mods'] = bool(state)
            save_settings()
        self.right_click_toggle_box.stateChanged.connect(_rc_changed)
        self.settings_layout.addWidget(self.right_click_toggle_box)

        # Version display (centered)
        v_layout = QHBoxLayout()
        v_layout.addStretch()
        self.version_label = QLabel(f"Version {settings.get('version', SCRIPT_VERSION)}")
        self.version_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        v_layout.addWidget(self.version_label)
        v_layout.addStretch()
        self.settings_layout.addLayout(v_layout)

        # Update controls: check for updates + two update buttons
        update_row = QHBoxLayout()
        self.check_updates_btn = QPushButton("Check for updates")
        self.check_updates_btn.clicked.connect(self.check_updates_manual)
        update_row.addWidget(self.check_updates_btn)

        self.update_modmanager_btn = QPushButton("Update modmanager (launch updater)")
        self.update_modmanager_btn.clicked.connect(self.launch_update_modmanager)
        update_row.addWidget(self.update_modmanager_btn)

        self.update_installer_btn = QPushButton("Update installer (update.exe)")
        self.update_installer_btn.clicked.connect(self.update_installer_exe)
        update_row.addWidget(self.update_installer_btn)

        self.settings_layout.addLayout(update_row)

        # Search results display
        self.search_results_label = QLabel("")
        self.search_results_label.setWordWrap(True)
        self.search_results_label.setStyleSheet("color: cyan; font-size: 9px;")
        self.settings_layout.addWidget(self.search_results_label)

        # Spacer
        self.settings_layout.addStretch()

    # -------------------- FIXES TAB (scripts runner) --------------------
    def create_fixes_tab(self):
        # target label
        tgt = settings.get("script_targets", {}).get(self.selected_game,
                                                      settings.get("mod_paths", {}).get(self.selected_game, "No target selected"))
        # Compact target row with buttons to save vertical space
        self.fixes_target_label = QLabel(tgt)
        target_row = QHBoxLayout()
        lbl = QLabel("Target Folder:")
        lbl.setMaximumWidth(110)
        target_row.addWidget(lbl)
        self.fixes_target_label.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.fixes_target_label.setMaximumHeight(24)
        # Slightly dim the path color for readability
        self.fixes_target_label.setStyleSheet("color: #bdbdbd;")
        target_row.addWidget(self.fixes_target_label, 1)

        btn_sel = QPushButton("Select Target Folder")
        btn_sel.clicked.connect(self.select_fixes_target_folder)
        target_row.addWidget(btn_sel)
        btn_refresh = QPushButton("Refresh Scripts")
        btn_refresh.clicked.connect(self.populate_fixes_scripts)
        target_row.addWidget(btn_refresh)
        # Download RabbitFX button (per-game links)
        btn_rabbit = QPushButton("Download RabbitFX")
        btn_rabbit.clicked.connect(self.open_rabbitfx)
        target_row.addWidget(btn_rabbit)

        self.fixes_layout.addLayout(target_row)

        # Create list and info side-by-side to use space efficiently
        self.fixes_list = QListWidget()
        self.fixes_list.itemSelectionChanged.connect(self.on_fixes_selection_changed)

        self.fixes_run_btn = QPushButton("Run Selected Fix")
        self.fixes_run_btn.setEnabled(False)
        self.fixes_run_btn.clicked.connect(self.run_selected_fix)

        # Info display (shared across all games) - loads resources/info.json
        self.fixes_info = QTextEdit()
        self.fixes_info.setReadOnly(True)
        self.fixes_info.setPlaceholderText("No info available.")
        # Theme-aware styling to ensure readable text on dark/light themes
        theme_mode = settings.get("theme", "dark")
        if theme_mode in ("dark", "game"):
            info_style = "background-color: #0f0f0f; color: #e0e0e0; border: 1px solid rgba(255,255,255,0.06); padding:6px; border-radius:6px;"
        else:
            info_style = "background-color: #f5f5f5; color: #222; border: 1px solid #bbb; padding:6px; border-radius:6px;"
        self.fixes_info.setStyleSheet(info_style)

        # Layout: left column (list + run button), right column (Info label + box)
        fixes_main = QHBoxLayout()

        left_col = QVBoxLayout()
        self.fixes_list.setMaximumHeight(420)
        left_col.addWidget(self.fixes_list)
        left_col.addWidget(self.fixes_run_btn)

        right_col = QVBoxLayout()
        info_lbl = QLabel("Info:")
        info_lbl.setMaximumHeight(20)
        right_col.addWidget(info_lbl)
        self.fixes_info.setMaximumHeight(420)
        right_col.addWidget(self.fixes_info)

        fixes_main.addLayout(left_col, 3)
        fixes_main.addLayout(right_col, 2)

        self.fixes_layout.addLayout(fixes_main)

        # Terminal/process bookkeeping (scripts run in native consoles)
        self.fixes_process = None
        self.fixes_thread = None

        QTimer.singleShot(100, self.populate_fixes_scripts)
        QTimer.singleShot(200, self.load_fixes_info)

    def select_fixes_target_folder(self):
        # Start dialog in previously used script target for this game, then fallback to mod path or base dir
        initial = settings.get("script_targets", {}).get(self.selected_game) or settings.get("mod_paths", {}).get(self.selected_game) or BASE_DIR
        folder = QFileDialog.getExistingDirectory(self, "Select Target Folder", initial)
        if folder:
            settings.setdefault("script_targets", {})[self.selected_game] = folder
            save_settings()
            self.fixes_target_label.setText(folder)
            self.validate_fixes_run_button()

    def update_fixes_tab(self):
        """Update Fixes tab when game is changed - load saved target path and refresh scripts."""
        tgt = settings.get("script_targets", {}).get(self.selected_game,
                                                      settings.get("mod_paths", {}).get(self.selected_game, "No target selected"))
        self.fixes_target_label.setText(tgt)
        self.populate_fixes_scripts()
        # Reload shared info text for fixes area
        try:
            self.load_fixes_info()
        except Exception:
            pass

    def populate_fixes_scripts(self):
        self.fixes_list.clear()
        sub = self.selected_game
        folder = os.path.join(RESOURCES, sub)
        if os.path.exists(folder):
            try:
                for f in sorted(os.listdir(folder)):
                    if f.endswith('.py'):
                        self.fixes_list.addItem(f"{f} [PY]")
                    elif f.endswith('.exe'):
                        self.fixes_list.addItem(f"{f} [EXE]")
            except Exception:
                pass
        self.validate_fixes_run_button()

    def on_fixes_selection_changed(self):
        self.validate_fixes_run_button()

    def validate_fixes_run_button(self):
        sel = self.fixes_list.currentItem()
        target = settings.get("script_targets", {}).get(self.selected_game) or settings.get("mod_paths", {}).get(self.selected_game)
        self.fixes_run_btn.setEnabled(bool(sel and target))

    def load_fixes_info(self):
        """Load shared info text from resources/info.json and display in the fixes info widget."""
        info_file = os.path.join(RESOURCES, "info.json")
        text = ""
        if os.path.exists(info_file):
            try:
                with open(info_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict) and "info" in data:
                        text = str(data.get("info") or "")
                    else:
                        # If it's not a dict with 'info', pretty-print the JSON
                        text = json.dumps(data, indent=2, ensure_ascii=False)
            except Exception:
                text = "(Failed to load info.json)"
        else:
            text = "(No info.json found in resources)"

        try:
            self.fixes_info.setPlainText(text)
        except Exception:
            pass

    def get_python_executable(self):
        p = shutil.which("python")
        if p:
            return p
        if sys.executable and os.path.basename(sys.executable).lower().startswith("python"):
            return sys.executable
        return None

    def run_selected_fix(self):
        it = self.fixes_list.currentItem()
        if not it:
            QMessageBox.warning(self, "Warning", "Select a script first.")
            return
        script_name = it.text().split(" [")[0]
        threading.Thread(target=self._run_fix_thread, args=(script_name,), daemon=True).start()

    # Output widget removed; keep method name no-op for compatibility
    def clear_fixes_output(self):
        return

    def send_fixes_input(self):
        """Send user input to the running process."""
        # Interactive input removed; scripts run in their own console windows.
        return

    def _run_fix_thread(self, script_name):
        try:
            src = os.path.join(RESOURCES, self.selected_game, script_name)
            if not os.path.exists(src):
                self._append_output(f"ERROR: Script not found: {src}")
                return

            target = settings.get("script_targets", {}).get(self.selected_game) or settings.get("mod_paths", {}).get(self.selected_game)
            if not target:
                self._append_output("ERROR: No target folder configured.")
                return

            dst = os.path.join(target, script_name)
            try:
                shutil.copy(src, dst)
                self._append_output(f"[INFO] Copied {script_name} to {target}")
            except Exception as e:
                self._append_output(f"[ERROR] Copy failed: {e}")
                return

            try:
                proc = None
                if script_name.endswith('.py'):
                    py = self.get_python_executable()
                    if not py:
                        self._append_output("[ERROR] Python executable not found.")
                        return
                    self._append_output(f"[INFO] Running: {script_name}")
                    # Launch in a new console window on Windows with proper working directory
                    if sys.platform == "win32":
                        # Use cmd to ensure working directory is set correctly
                        proc = subprocess.Popen(
                            ['cmd', '/k', f'cd /d {target} && python {script_name}'],
                            creationflags=subprocess.CREATE_NEW_CONSOLE
                        )
                    else:
                        proc = subprocess.Popen([py, dst], cwd=target)
                    self._append_output("[INFO] Script opened in a new window. Interact with it there.")
                else:
                    self._append_output(f"[INFO] Running: {script_name}")
                    if sys.platform == "win32":
                        proc = subprocess.Popen(
                            ['cmd', '/k', f'cd /d {target} && {script_name}'],
                            creationflags=subprocess.CREATE_NEW_CONSOLE
                        )
                    else:
                        proc = subprocess.Popen([dst], cwd=target)
                    self._append_output("[INFO] Script opened in a new window. Interact with it there.")
                
                # Wait for the script to complete
                if proc:
                    proc.wait()
                    self._append_output(f"[INFO] Script completed with exit code: {proc.returncode}")
                    
            except Exception as e:
                self._append_output(f"[ERROR] {e}")
            finally:
                # Clean up: delete the copied script
                try:
                    if os.path.exists(dst):
                        os.remove(dst)
                        self._append_output(f"[INFO] Cleaned up: {script_name}")
                except Exception as e:
                    self._append_output(f"[WARNING] Could not delete {script_name}: {e}")

        except Exception as e:
            self._append_output(f"[ERROR] {e}")



    def _append_output(self, text):
        """Safely append text to output terminal from any thread."""
        # Output widget removed; write to console instead
        try:
            print(text)
        except Exception:
            pass

    def toggle_auto_check(self, state):
        settings["auto_check_updates"] = bool(state)
        save_settings()

    def change_mod_path(self, game):
        folder = QFileDialog.getExistingDirectory(self,f"Select mod folder for {GAMES[game]}")
        if folder:
            settings["mod_paths"][game] = folder
            self.path_labels[game].setText(f"{GAMES[game]}: {folder}")
            try:
                os.makedirs(os.path.join(folder, "BufferValues"), exist_ok=True)
            except Exception:
                pass
            save_settings()
            self.load_items()

    # -------------------- GAME / CATEGORY --------------------
    def change_game(self):
        self.selected_game = self.game_combo.currentData()
        settings["last_selected_game"] = self.selected_game
        save_settings()
        self.ensure_buffer_values_folders()
        # Reapply theme if game theme is selected (to update accent colors)
        if settings.get("theme", "dark") == "game":
            self.apply_theme()
        self.load_items()
        try:
            self.initialize_browse_for_game()
        except Exception:
            pass
        try:
            self.update_fixes_tab()
        except Exception:
            pass

    def open_gamebanana(self):
        """Open the GameBanana page for the currently selected game."""
        key = self.game_combo.currentData()
        url = GAMEBANANA_URLS.get(key)
        if url:
            try:
                webbrowser.open(url)
            except Exception as e:
                QMessageBox.warning(self, "Error", f"Failed to open browser: {e}")
        else:
            QMessageBox.information(self, "Info", "No GameBanana page configured for this game.")

    def open_rabbitfx(self):
        """Open the RabbitFX (GameBanana mod) page for supported games."""
        key = self.game_combo.currentData()
        url = RABBITFX_URLS.get(key)
        if url:
            try:
                webbrowser.open(url)
            except Exception as e:
                QMessageBox.warning(self, "Error", f"Failed to open browser: {e}")
        else:
            QMessageBox.information(self, "Info", "No RabbitFX download configured for this game.")

    def tab_changed(self,index):
        tab_text = (self.tab_widget.tabText(index) or "").strip().lower()
        category_map = {cat.lower(): cat for cat in CATEGORIES}
        category_map["ui"] = "ui"
        if tab_text in category_map:
            self.selected_category = category_map[tab_text]
            self.load_items()
        else:
            self.selected_item = None
            self.clear_mod_list()

    # -------------------- LOAD ITEMS --------------------
    def load_items(self):
        if self.selected_category not in self.tabs:
            return
        self.selected_item = None
        tab_data = self.tabs[self.selected_category]
        grid = tab_data["grid"]
        # clear grid
        for i in reversed(range(grid.count())):
            widget = grid.itemAt(i).widget()
            if widget:
                widget.setParent(None)

        base_path = settings["mod_paths"].get(self.selected_game, default_mod_paths[self.selected_game])
        main_cat_folder = build_item_folder_path(base_path, self.selected_category)

        if self.selected_category == "buffervalues":
            os.makedirs(main_cat_folder, exist_ok=True)
            self.items = [{"id": "__root__", "name": "BufferValues"}]
        else:
            json_file = os.path.join(RESOURCES,f"{self.selected_category}_{self.selected_game}.json")
            if os.path.exists(json_file):
                try:
                    with open(json_file,"r", encoding="utf-8") as f:
                        self.items = json.load(f)
                except Exception:
                    self.items = []
            else:
                self.items = []

        # Load added characters if this is the characters category
        if self.selected_category == "characters":
            added = load_added_characters(self.selected_game)
            self.items.extend(added)

        # Sort items: favorites first, then by name (use per-game favorites file)
        favorites = load_favorites(self.selected_game)
        self.items.sort(key=lambda x: (x["id"] not in favorites, x.get("name", "")))

        # Create main category folder if needed (ask user first)
        main_cat_folder = build_item_folder_path(base_path, self.selected_category)
        if not os.path.exists(main_cat_folder) and self.items:
            reply = QMessageBox.question(
                self,
                "Create Folder?",
                f"The folder for '{self.selected_category}' doesn't exist.\n\nCreate it now?",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No
            )
            if reply == QMessageBox.StandardButton.Yes:
                try:
                    os.makedirs(main_cat_folder, exist_ok=True)
                except Exception as e:
                    print(f"Failed to create folder: {e}")
        
        # Create item subfolders only if main folder exists
        if os.path.exists(main_cat_folder) and self.selected_category != "buffervalues":
            for item in self.items:
                folder = os.path.join(main_cat_folder, item["id"])
                try:
                    os.makedirs(folder, exist_ok=True)
                except Exception:
                    pass

        # populate grid (arranged dynamically)
        self.arrange_grid(grid)

    # -------------------- ITEM WIDGET --------------------
    def create_item_widget(self,item):
        frame = QFrame()
        frame.setAcceptDrops(True)  # Enable drop on character items
        frame.setMaximumWidth(220)  # Fixed width to prevent expansion beyond grid column
        frame.setMinimumWidth(200)
        layout = QVBoxLayout()
        frame.setLayout(layout)
        
        # Store item data on frame for drag/drop
        frame.character_data = {"game": self.selected_game, "category": self.selected_category, "item": item}

        # Modern styling for the frame (theme-aware)
        frame.setFrameShape(QFrame.Shape.Box)
        theme_mode = settings.get("theme", "dark")
        if theme_mode == "dark":
            frame_style = """
                QFrame {
                    border: 2px solid #444;
                    border-radius: 8px;
                    background-color: #222;
                    padding: 8px;
                }
                QFrame:hover {
                    border: 2px solid #0078d4;
                    background-color: #2a2a2a;
                }
            """
        elif theme_mode == "game":
            pal = self._get_game_colors(self.selected_game)
            primary = pal['primary']
            secondary = pal['secondary']
            tertiary = pal['tertiary']
            bg_light = pal['bg_light']
            frame_style = f"""
                QFrame {{
                    border: 2px solid {tertiary};
                    border-radius: 8px;
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 {bg_light}, stop:1 rgba(200,200,200,0.1));
                    padding: 8px;
                }}
                QFrame:hover {{
                    border: 2px solid {primary};
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 {bg_light}, stop:1 rgba(210,210,210,0.15));
                }}
            """
        else:
            frame_style = """
                QFrame {
                    border: 2px solid #ccc;
                    border-radius: 8px;
                    background-color: #f5f5f5;
                    padding: 8px;
                }
                QFrame:hover {
                    border: 2px solid #0078d4;
                    background-color: #ffffff;
                }
            """
        frame.setStyleSheet(frame_style)
        
        # Top row: Favorite button only (warning moves to top-right corner)
        top_row = QHBoxLayout()
        top_row.setContentsMargins(0, 0, 0, 5)
        fav_btn = QPushButton()
        fav_btn.setMaximumWidth(30)
        fav_btn.setMaximumHeight(30)
        favorites = load_favorites(self.selected_game)
        is_fav = item["id"] in favorites
        fav_btn.setText("⭐" if is_fav else "☆")
        fav_btn.setStyleSheet("""QPushButton { 
            background: transparent; 
            border: none; 
            font-size: 18px;
            padding: 2px;
        }
        QPushButton:hover {
            opacity: 0.8;
        }
        """)
        fav_btn.clicked.connect(lambda: self.toggle_favorite(item))

        # Warning icon (top-right corner) - hidden by default
        warning_label = QLabel()
        warning_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        # Theme-aware color and transparent background; render as a small colored circle with '!'
        # Default colors; for 'game' theme we'll use the game accent
        theme_mode = settings.get("theme", "dark")
        if theme_mode == "dark":
            warn_color = "#ff6b6b"
        elif theme_mode == "game":
            tertiary = self._get_game_colors(self.selected_game)['tertiary']
            primary = self._get_game_colors(self.selected_game)['secondary']
            warn_color = tertiary
        else:
            warn_color = "#b00020"
        warning_label.setText("!")
        warning_label.setFixedSize(20, 20)  # Small corner icon
        if theme_mode == "game":
            # Use gradient background for warning icon in game theme
            warning_label.setStyleSheet(f"background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {warn_color}, stop:1 {primary}); color: white; font-weight: bold; font-size: 12px; border-radius: 10px;")
        else:
            warning_label.setStyleSheet(f"background-color: {warn_color}; color: white; font-weight: bold; font-size: 12px; border-radius: 10px;")
        warning_label.setVisible(False)  # Hidden until needed

        top_row.addWidget(fav_btn)
        top_row.addStretch()
        top_row.addWidget(warning_label)
        layout.addLayout(top_row)

        # Icon
        # Try multiple extensions for icon files (including .wep/.webp)
        icon_label = None
        try:
            icon_dir = os.path.join(RESOURCES, "icons", f"{self.selected_game}_{self.selected_category}")
            exts = ['.webp', '.png', '.jpg', '.jpeg', '.bmp', '.gif']
            found = None
            for e in exts:
                p = os.path.join(icon_dir, f"{item['id']}{e}")
                if os.path.exists(p):
                    found = p
                    break
            if found:
                pix = QPixmap(found).scaled(100, 100, Qt.AspectRatioMode.KeepAspectRatio)
                icon_label = QLabel()
                icon_label.setPixmap(pix)
                icon_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
                layout.addWidget(icon_label)
        except Exception:
            pass

        # Name label with modern styling
        name_label = QLabel(item['name'])
        name_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        # Theme-aware name color (treat 'game' as dark)
        theme_mode = settings.get("theme", "dark")
        if theme_mode in ("dark", "game"):
            name_style = "color: #fff; font-weight: bold; font-size: 11px;"
        else:
            name_style = "color: #111; font-weight: bold; font-size: 11px;"
        name_label.setStyleSheet(name_style)
        layout.addWidget(name_label)

        # Mod counter label
        counter_label = QLabel()
        counter_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        counter_label.setStyleSheet("color: #0078d4; font-size: 10px;")
        layout.addWidget(counter_label)
        item['_counter_label'] = counter_label

        # Attach warning_label created above to item for updates
        item['_warning_label'] = warning_label

        self.update_mod_counter(item)

        # Click to select
        frame.mousePressEvent = lambda e, i=item: self.select_item(i)
        
        return frame

    def toggle_favorite(self, item):
        """Toggle favorite status for an item."""
        if "characters" not in self.selected_category:
            QMessageBox.information(self, "Info", "Favorites are only available for characters.")
            return
        # Use per-game favorites file
        favs = load_favorites(self.selected_game) or []
        if item["id"] in favs:
            try:
                favs.remove(item["id"])
            except ValueError:
                pass
        else:
            favs.append(item["id"])
        save_favorites(self.selected_game, favs)
        self.load_items()  # Refresh to reorder by favorites


    def import_mod_from_path(self, source_path):
        """Import a mod folder from an external path to the selected character folder."""
        if not self.selected_item:
            QMessageBox.warning(self, "No character selected", "Please select a character first!")
            return

        try:
            # Get current character's mod folder
            char_mod_folder = os.path.join(
                settings["mod_paths"].get(self.selected_game, default_mod_paths[self.selected_game]),
            )
            char_mod_folder = build_item_folder_path(char_mod_folder, self.selected_category, self.selected_item["id"])

            os.makedirs(char_mod_folder, exist_ok=True)

            # Get mod name from source folder
            mod_name = os.path.basename(source_path.rstrip(os.sep))
            target_path = os.path.join(char_mod_folder, mod_name)

            # If a folder with the same name exists, rename with _copy suffix
            counter = 1
            orig_target_path = target_path
            while os.path.exists(target_path):
                target_path = f"{orig_target_path}_copy{counter}"
                counter += 1

            # Copy the folder
            shutil.copytree(source_path, target_path)

            # Reload mods for current character
            self.load_mods()

            QMessageBox.information(self, "Mod Imported", f"Mod '{mod_name}' imported successfully.")

        except Exception as e:
            QMessageBox.critical(self, "Error Importing Mod", f"Failed to import mod:\n{e}")
            print(f"Error importing mod: {e}")

    def import_mod_archive_path(self, archive_path):
        """Import a local archive file by extracting into the selected destination folder."""
        if not self.selected_item:
            QMessageBox.warning(self, "No destination selected", "Please select a destination first!")
            return
        if not os.path.isfile(archive_path):
            QMessageBox.warning(self, "Invalid File", "Dropped path is not a file.")
            return
        try:
            base_root = settings["mod_paths"].get(self.selected_game, default_mod_paths[self.selected_game])
            target_root = build_item_folder_path(base_root, self.selected_category, self.selected_item.get("id"))
            os.makedirs(target_root, exist_ok=True)

            base_name = self._safe_mod_folder_name(os.path.splitext(os.path.basename(archive_path))[0])
            target_path = os.path.join(target_root, base_name)
            copy_idx = 1
            while os.path.exists(target_path):
                target_path = os.path.join(target_root, f"{base_name}_copy{copy_idx}")
                copy_idx += 1

            with tempfile.TemporaryDirectory() as temp_dir:
                extract_dir = os.path.join(temp_dir, "extract")
                os.makedirs(extract_dir, exist_ok=True)
                self._extract_archive(archive_path, extract_dir)

                entries = [os.path.join(extract_dir, name) for name in os.listdir(extract_dir)]
                if len(entries) == 1 and os.path.isdir(entries[0]):
                    shutil.copytree(entries[0], target_path)
                else:
                    os.makedirs(target_path, exist_ok=True)
                    for entry in entries:
                        dest = os.path.join(target_path, os.path.basename(entry))
                        if os.path.isdir(entry):
                            shutil.copytree(entry, dest)
                        else:
                            shutil.copy2(entry, dest)

            self.load_mods()
            QMessageBox.information(self, "Mod Imported", f"Archive '{os.path.basename(archive_path)}' imported successfully.")
        except Exception as e:
            QMessageBox.critical(self, "Error Importing Archive", f"Failed to import archive:\n{e}")
            print(f"Error importing archive: {e}")

    def import_mod_source(self, source_path):
        """Import a dropped source path (folder or supported archive)."""
        if not source_path:
            return
        if os.path.isdir(source_path):
            self.import_mod_from_path(source_path)
            return
        if os.path.isfile(source_path):
            ext = os.path.splitext(source_path)[1].lower()
            if ext in (".zip", ".rar", ".7z"):
                self.import_mod_archive_path(source_path)
                return
        QMessageBox.warning(self, "Unsupported Drop", "Drop a mod folder or a .zip/.rar/.7z archive.")

    def _dropped_local_paths(self, mime_data):
        """Extract local file/folder paths from a drop payload."""
        paths = []
        try:
            if not mime_data or not mime_data.hasUrls():
                return paths
            for url in mime_data.urls():
                local_path = url.toLocalFile()
                if local_path and os.path.exists(local_path):
                    paths.append(local_path)
        except Exception:
            return []
        return paths

    def dragEnterEvent(self, event):
        """Accept drag operations that contain local files/folders."""
        try:
            if self._dropped_local_paths(event.mimeData()):
                event.acceptProposedAction()
                return
        except Exception:
            pass
        event.ignore()

    def dragMoveEvent(self, event):
        """Maintain accepted copy-action while dragging over the app."""
        try:
            if self._dropped_local_paths(event.mimeData()):
                event.setDropAction(Qt.DropAction.CopyAction)
                event.accept()
                return
        except Exception:
            pass
        event.ignore()

    def dropEvent(self, event):
        """Import dropped folders/files into the selected destination folder."""
        try:
            source_paths = self._dropped_local_paths(event.mimeData())
            if not source_paths:
                event.ignore()
                return
            if not self.selected_item:
                QMessageBox.warning(
                    self,
                    "No destination selected",
                    "Select a destination folder first, then drop mod folders/files to import.",
                )
                event.ignore()
                return
            for source_path in source_paths:
                self.import_mod_source(source_path)
            event.acceptProposedAction()
        except Exception as e:
            QMessageBox.critical(self, "Drop Error", f"Could not import dropped folder(s):\n{e}")
            event.ignore()

    def save_preview_image_for_installed_mod(self, preview_url, mod_folder):
        """Download a preview image URL into the installed mod folder.

        Returns saved file path on success, None on failure.
        """
        if not preview_url or not mod_folder or not os.path.isdir(mod_folder):
            return None

        ext = guess_image_extension_from_url(preview_url, default_ext=".jpg")
        target_path = os.path.join(mod_folder, f"preview{ext}")

        req = urllib.request.Request(preview_url, headers={"User-Agent": "ModManager-Preview"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            if not data:
                return None
            with open(target_path, "wb") as f:
                f.write(data)
            return target_path
        except Exception as e:
            print(f"Failed to save preview image ({preview_url}): {e}")
            return None


    def arrange_grid(self, grid):
        """Arrange items dynamically based on available width."""
        # clear grid
        for i in reversed(range(grid.count())):
            widget = grid.itemAt(i).widget()
            if widget:
                widget.setParent(None)

        # determine number of columns based on available content width
        tab_data = self.tabs.get(self.selected_category)
        if not tab_data:
            cols = 3
            content = None
            scroll = None
        else:
            content = tab_data.get("content")
            scroll = tab_data.get("scroll")
            # Get the actual usable width from scroll viewport
            avail_w = None
            try:
                if scroll and hasattr(scroll, 'viewport'):
                    avail_w = scroll.viewport().width()
            except Exception:
                avail_w = None
            if not avail_w and scroll:
                avail_w = scroll.width()
            if not avail_w:
                avail_w = 660
            
            # Constrain content width to viewport to prevent horizontal scroll
            if content and scroll:
                content.setMaximumWidth(int(avail_w))
            
            item_width = 220
            cols = max(1, int(avail_w) // item_width)

        row = 0
        col = 0
        for item in self.items:
            btn = self.create_item_widget(item)
            grid.addWidget(btn, row, col)
            col += 1
            if col >= cols:
                col = 0
                row += 1

        # set stretch for responsiveness — all columns expand equally
        for c in range(max(1, cols)):
            grid.setColumnStretch(c, 1)
        # Add a final stretch column that expands to fill remaining space
        grid.setColumnStretch(cols, 100)
        for r in range(row + 1):
            grid.setRowStretch(r, 0)

        # (no forced minimum height here) allow the scroll area to size naturally

    def resizeEvent(self, event):
        # rearrange current grid after resize with debounce
        try:
            if self.resize_debounce_timer:
                self.resize_debounce_timer.stop()
            self.resize_debounce_timer = QTimer()
            self.resize_debounce_timer.setSingleShot(True)
            self.resize_debounce_timer.timeout.connect(self._do_resize_arrange)
            self.resize_debounce_timer.start(200)  # 200ms debounce
        except Exception:
            pass
        super().resizeEvent(event)

    def _do_resize_arrange(self):
        try:
            if self.selected_category in self.tabs:
                grid = self.tabs[self.selected_category]["grid"]
                self.arrange_grid(grid)
            if hasattr(self, "browse_results_data") and self.browse_results_data:
                self.render_browse_cards()
        except Exception:
            pass

    # -------------------- SELECT ITEM --------------------
    def select_item(self,item):
        self.selected_item = item
        self.detail_character_label.setText(f"{item.get('name', 'Unknown')} - {self.selected_category.capitalize()}")
        try:
            self.update_browse_target_label()
            self.browse_install_btn.setEnabled(self.browse_selected_file is not None and self.selected_item is not None)
        except Exception:
            pass
        self.show_detail_screen()
        self.load_mods()

    def show_detail_screen(self):
        try:
            self.content_stack.setCurrentWidget(self.detail_page)
        except Exception:
            pass

    def show_overview_screen(self):
        try:
            self.content_stack.setCurrentWidget(self.overview_page)
        except Exception:
            pass

    def add_new_character(self):
        """Add a new character to the game."""
        if self.selected_category != "characters":
            QMessageBox.warning(self, "Info", "Only characters can be added.")
            return
        # Prompt for character ID using QInputDialog for robustness
        char_id, ok = QInputDialog.getText(self, "Add New Character", "Enter character ID (unique identifier, e.g., 'fischl'):")
        if not ok:
            return
        char_id = (char_id or "").strip().lower()
        if not char_id:
            QMessageBox.warning(self, "Error", "Character ID cannot be empty.")
            return

        # Prompt for display name
        char_name, ok2 = QInputDialog.getText(self, "Add New Character", "Enter character display name (e.g., 'Fischl'):")
        if not ok2:
            return
        char_name = (char_name or "").strip()
        if not char_name:
            QMessageBox.warning(self, "Error", "Character name cannot be empty.")
            return

        # Lowercase ID sanitization: no spaces
        if " " in char_id:
            QMessageBox.warning(self, "Error", "Character ID cannot contain spaces.")
            return

        # Check duplicates against default and previously added characters
        default_file = os.path.join(RESOURCES, f"characters_{self.selected_game}.json")
        existing_ids = set()
        if os.path.exists(default_file):
            try:
                with open(default_file, "r", encoding="utf-8") as f:
                    defaults = json.load(f)
                    for c in defaults:
                        existing_ids.add(c.get("id"))
            except Exception:
                pass
        added_chars = load_added_characters(self.selected_game)
        for c in added_chars:
            existing_ids.add(c.get("id"))

        if char_id in existing_ids:
            QMessageBox.warning(self, "Error", f"Character ID '{char_id}' already exists.")
            return

        # Create and save new character
        new_char = {"id": char_id, "name": char_name}
        added_chars.append(new_char)
        save_added_characters(self.selected_game, added_chars)
        QMessageBox.information(self, "Success", f"Character '{char_name}' added successfully!")
        self.load_items()

    # -------------------- LOAD MODS --------------------
    def clear_mod_list(self):
        self.mod_list_widget.clear()
        self.selected_mod_path = None
        self.preview_images = []
        self.preview_index = 0
        self.preview_label.setText("No preview available")
        self.preview_label.setPixmap(QPixmap())
        self.prev_img_btn.setEnabled(False)
        self.next_img_btn.setEnabled(False)
        self.reset_ini_editor("Select a mod to load INI values.")

    def load_mods(self):
        if self._loading_mods:
            return
        self._loading_mods = True
        prev_mod_path = self.selected_mod_path  # capture before clear_mod_list resets it
        try:
            self.clear_mod_list()
            if not self.selected_item:
                return

            char_folder = os.path.join(
                settings["mod_paths"].get(self.selected_game, default_mod_paths[self.selected_game]),
            )
            char_folder = build_item_folder_path(char_folder, self.selected_category, self.selected_item["id"])
            
            # Ask to create folder if it doesn't exist
            if not os.path.exists(char_folder):
                reply = QMessageBox.question(
                    self,
                    "Create Folder?",
                    f"The folder for '{self.selected_item['name']}' doesn't exist.\n\nCreate it now?",
                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                    QMessageBox.StandardButton.No
                )
                if reply == QMessageBox.StandardButton.Yes:
                    try:
                        os.makedirs(char_folder, exist_ok=True)
                    except Exception as e:
                        print(f"Failed to create folder: {e}")
                        return
                else:
                    return

            # Watch folder: unschedule & schedule
            try:
                self.observer.unschedule_all()
                self.observer.schedule(ModFolderHandler(self.request_mods_refresh), char_folder, recursive=True)
            except Exception:
                # observer might not be running on some platforms but ignore for now
                pass

            mods = []
            try:
                for f in os.listdir(char_folder):
                    full_path = os.path.join(char_folder, f)
                    if os.path.isdir(full_path):
                        disabled = f.startswith("DISABLED_")
                        display_name = f.replace("DISABLED_", "")
                        mods.append({"name": f, "display": display_name, "disabled": disabled, "path": full_path})
            except FileNotFoundError:
                pass

            for m in mods:
                item_text = m["display"]
                font = QFont()
                if m["disabled"]:
                    item_text = f"[DISABLED] {item_text}"
                    font.setItalic(True)
                else:
                    font.setBold(True)
                list_item = QListWidgetItem(item_text)
                list_item.setData(Qt.ItemDataRole.UserRole, m["path"])
                list_item.setFont(font)
                self.mod_list_widget.addItem(list_item)

            if self.mod_list_widget.count() > 0:
                restored = False
                if prev_mod_path:
                    prev_name = os.path.basename(prev_mod_path)
                    prev_dir = os.path.dirname(prev_mod_path)
                    # Also match the toggled variant (DISABLED_ prefix added/removed)
                    if prev_name.startswith("DISABLED_"):
                        alt_name = prev_name[len("DISABLED_"):]
                    else:
                        alt_name = "DISABLED_" + prev_name
                    alt_path = os.path.join(prev_dir, alt_name)
                    for i in range(self.mod_list_widget.count()):
                        itm = self.mod_list_widget.item(i)
                        p = itm.data(Qt.ItemDataRole.UserRole) if itm else None
                        if p and (p == prev_mod_path or p == alt_path):
                            self.mod_list_widget.setCurrentItem(itm)
                            self.select_mod(itm)
                            restored = True
                            break
                if not restored:
                    first_item = self.mod_list_widget.item(0)
                    self.mod_list_widget.setCurrentItem(first_item)
                    self.select_mod(first_item)

            self.update_mod_counters()
        finally:
            self._loading_mods = False

    # -------------------- MOD COUNTERS --------------------
    def update_mod_counters(self):
        for item in self.items:
            self.update_mod_counter(item)

    def update_mod_counter(self,item):
        base_path = settings["mod_paths"].get(self.selected_game, default_mod_paths[self.selected_game])
        folder_path = build_item_folder_path(base_path, self.selected_category, item.get("id"))
        count = 0
        enabled_count = 0
        if os.path.exists(folder_path):
            try:
                subfolders = [f for f in os.listdir(folder_path) if os.path.isdir(os.path.join(folder_path,f))]
            except Exception:
                subfolders = []
            count = len(subfolders)
            enabled_count = len([f for f in subfolders if not f.startswith("DISABLED_")])

        # Update counter
        if '_counter_label' in item:
            item['_counter_label'].setText(f"Mods: {count}")

        # Update warning icon visibility only for characters
        if '_warning_label' in item:
            if self.selected_category == "characters" and enabled_count > 1:
                # Update tooltip with enabled mod count
                item['_warning_label'].setVisible(True)
                item['_warning_label'].setToolTip(f"{enabled_count} mods enabled")
                # If we're in game theme, adjust color to accent in apply_theme; otherwise tooltip suffices
            else:
                item['_warning_label'].setVisible(False)

    # -------------------- SELECT MOD --------------------
    def select_mod(self, list_item):
        try:
            if list_item is None:
                return
            path = list_item.data(Qt.ItemDataRole.UserRole)
            if not path or not os.path.exists(path):
                return
            if not os.path.isdir(path):
                return
            self.selected_mod_path = path

            # Highlight selection in list
            self.mod_list_widget.blockSignals(True)
            try:
                for i in range(self.mod_list_widget.count()):
                    item = self.mod_list_widget.item(i)
                    if item:
                        item.setBackground(Qt.GlobalColor.transparent)
                list_item.setBackground(Qt.GlobalColor.lightGray)
            finally:
                self.mod_list_widget.blockSignals(False)

            # Show preview for the selected mod
            self.show_mod_preview(path)
            self.load_ini_for_mod(path)

        except Exception as e:
            print(f"Error selecting mod: {e}")

        # -------------------- SHOW MOD PREVIEW --------------------
    def show_mod_preview(self, mod_folder_path):
        """Display images from mod folder (including subfolders) with navigation."""
        try:
            all_images = find_all_images_recursive(mod_folder_path)
            valid_images = []
            for img in all_images:
                try:
                    reader = QImageReader(img)
                    if reader.canRead():
                        valid_images.append(img)
                except Exception:
                    pass
            self.preview_images = valid_images
            self.preview_index = 0

            if not self.preview_images:
                self.preview_label.setText("No preview available")
                self.preview_label.setPixmap(QPixmap())
                self.prev_img_btn.setEnabled(False)
                self.next_img_btn.setEnabled(False)
                return

            # Enable buttons if multiple images
            self.prev_img_btn.setEnabled(len(self.preview_images) > 1)
            self.next_img_btn.setEnabled(len(self.preview_images) > 1)

            self._display_current_preview()
        except Exception as e:
            print(f"Failed to load preview: {e}")
            self.preview_label.setText("Error loading preview")
            self.preview_label.setPixmap(QPixmap())
            self.prev_img_btn.setEnabled(False)
            self.next_img_btn.setEnabled(False)
    def _display_current_preview(self):
        if not self.preview_images:
            return
        attempts = 0
        while self.preview_images and attempts < len(self.preview_images):
            img_path = self.preview_images[self.preview_index]
            try:
                reader = QImageReader(img_path)
                if reader.canRead():
                    img = reader.read()
                    if not img.isNull():
                        pix = QPixmap.fromImage(img).scaled(
                            self.preview_label.width(),
                            self.preview_label.height(),
                            Qt.AspectRatioMode.KeepAspectRatio,
                            Qt.TransformationMode.SmoothTransformation
                        )
                        self.preview_label.setPixmap(pix)
                        self.prev_img_btn.setEnabled(len(self.preview_images) > 1)
                        self.next_img_btn.setEnabled(len(self.preview_images) > 1)
                        return
            except Exception:
                pass

            # Drop unreadable image and try the next one.
            self.preview_images.pop(self.preview_index)
            if self.preview_images:
                self.preview_index = self.preview_index % len(self.preview_images)
            attempts += 1

        self.preview_label.setText("No preview available")
        self.preview_label.setPixmap(QPixmap())
        self.prev_img_btn.setEnabled(False)
        self.next_img_btn.setEnabled(False)
    
    def show_prev_image(self):
        if not self.preview_images:
            return
        self.preview_index = (self.preview_index - 1) % len(self.preview_images)
        self._display_current_preview()

    def show_next_image(self):
        if not self.preview_images:
            return
        self.preview_index = (self.preview_index + 1) % len(self.preview_images)
        self._display_current_preview()


    # -------------------- TOGGLE MOD --------------------
    def toggle_selected_mod(self):
        if not self.selected_mod_path or not os.path.exists(self.selected_mod_path):
            return

        parent_folder = os.path.dirname(self.selected_mod_path)
        folder_name = os.path.basename(self.selected_mod_path)
        if folder_name.startswith("DISABLED_"):
            new_name = folder_name.replace("DISABLED_", "", 1)
        else:
            new_name = f"DISABLED_{folder_name}"
        new_path = os.path.join(parent_folder, new_name)
        try:
            os.rename(self.selected_mod_path, new_path)
            self.selected_mod_path = new_path
        except Exception as e:
            print(f"Failed to rename folder: {e}")
        self.load_mods()

    def toggle_mod_by_path(self, path):
        """Toggle a mod folder given its full path."""
        if not path or not os.path.exists(path):
            return
        parent_folder = os.path.dirname(path)
        folder_name = os.path.basename(path)
        if folder_name.startswith("DISABLED_"):
            new_name = folder_name.replace("DISABLED_", "", 1)
        else:
            new_name = f"DISABLED_{folder_name}"
        new_path = os.path.join(parent_folder, new_name)
        try:
            os.rename(path, new_path)
        except Exception as e:
            print(f"Failed to toggle folder: {e}")
        self.load_mods()

    # -------------------- OPEN FOLDER --------------------
    def open_selected_folder(self):
        if not self.selected_item:
            return
        folder = os.path.join(
            settings["mod_paths"].get(self.selected_game, default_mod_paths[self.selected_game]),
        )
        folder = build_item_folder_path(folder, self.selected_category, self.selected_item["id"])
        if os.path.exists(folder):
            open_folder(folder)

    def open_selected_mod_folder(self):
        if self.selected_mod_path and os.path.exists(self.selected_mod_path):
            open_folder(self.selected_mod_path)

    def reset_ini_editor(self, status_text="Select a mod to load INI values."):
        self.selected_ini_path = None
        self.ini_entries = []
        self.ini_key_list.blockSignals(True)
        self.ini_key_list.clear()
        self.ini_key_list.blockSignals(False)
        self.ini_value_input.clear()
        self.ini_back_input.clear()
        self.ini_file_label.setText("INI: No file selected")
        self.ini_status_label.setText(status_text)
        self.update_ini_save_button_state()

    def find_first_ini_file(self, mod_folder_path):
        if not mod_folder_path or not os.path.isdir(mod_folder_path):
            return None
        for root, dirs, files in os.walk(mod_folder_path):
            dirs.sort(key=str.lower)
            ini_files = sorted([f for f in files if f.lower().endswith(".ini")], key=str.lower)
            if ini_files:
                return os.path.join(root, ini_files[0])
        return None

    def extract_toggle_entries(self, ini_path):
        """Parse all [Key*] sections from a GIMI INI using raw line scanning.
        Returns list of dicts: {name, key, back} or (None, error_string) on read failure.
        """
        try:
            try:
                with open(ini_path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
            except UnicodeDecodeError:
                with open(ini_path, "r", encoding="latin-1") as f:
                    lines = f.readlines()
        except Exception as e:
            return None, str(e)

        sections = []
        current_name = None
        current_key = None
        current_back = None

        def _flush():
            if current_name is not None:
                sections.append({"name": current_name, "key": current_key, "back": current_back})

        for line in lines:
            stripped = line.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                _flush()
                section_name = stripped[1:-1]
                if section_name.lower().startswith("key"):
                    current_name = section_name
                    current_key = None
                    current_back = None
                else:
                    current_name = None
                    current_key = None
                    current_back = None
                continue
            if current_name is None:
                continue
            m = re.match(r'^\s*key\s*=\s*(.+)$', stripped, re.IGNORECASE)
            if m:
                current_key = m.group(1).strip()
                continue
            m = re.match(r'^\s*back\s*=\s*(.+)$', stripped, re.IGNORECASE)
            if m:
                current_back = m.group(1).strip()

        _flush()
        return sections, None

    def load_ini_for_mod(self, mod_folder_path):
        self.reset_ini_editor("Searching for INI file...")
        ini_path = self.find_first_ini_file(mod_folder_path)
        if not ini_path:
            self.ini_status_label.setText("No INI file found in this mod folder.")
            self.update_ini_save_button_state()
            return

        self.selected_ini_path = ini_path
        self.ini_file_label.setText(f"INI: {ini_path}")

        sections, err = self.extract_toggle_entries(ini_path)
        if sections is None:
            self.ini_status_label.setText(f"Failed to read INI: {err}")
            self.update_ini_save_button_state()
            return

        # Only keep sections that actually have a key= line
        self.ini_entries = [s for s in sections if s["key"]]

        self.ini_key_list.blockSignals(True)
        self.ini_key_list.clear()
        for entry in self.ini_entries:
            display = f"{entry['name']}  —  {entry['key']}"
            if entry["back"]:
                display += f"  /  back: {entry['back']}"
            list_item = QListWidgetItem(display)
            list_item.setData(Qt.ItemDataRole.UserRole, entry["name"])
            self.ini_key_list.addItem(list_item)
        self.ini_key_list.blockSignals(False)

        if self.ini_key_list.count() > 0:
            self.ini_key_list.setCurrentRow(0)
            self.on_ini_key_changed(0)
            self.ini_status_label.setText("Edit forward/backward key then click Save.")
        else:
            self.ini_value_input.clear()
            self.ini_back_input.clear()
            self.ini_status_label.setText("No [Key...] sections with a key binding found in this INI.")

        self.update_ini_save_button_state()

    def on_ini_key_changed(self, index):
        if index < 0 or index >= len(self.ini_entries):
            self.ini_value_input.clear()
            self.ini_back_input.clear()
            self.update_ini_save_button_state()
            return
        entry = self.ini_entries[index]
        self.ini_value_input.setText(entry["key"] or "")
        self.ini_back_input.setText(entry["back"] or "")
        self.update_ini_save_button_state()

    def update_ini_save_button_state(self):
        has_ini = bool(self.selected_ini_path and os.path.exists(self.selected_ini_path))
        has_key_choice = self.ini_key_list.count() > 0 and self.ini_key_list.currentRow() >= 0
        self.ini_save_btn.setEnabled(has_ini and has_key_choice)

    def save_ini_value(self):
        if not self.selected_ini_path or not os.path.exists(self.selected_ini_path):
            self.ini_status_label.setText("Cannot save: no INI file selected.")
            return

        idx = self.ini_key_list.currentRow()
        if idx < 0 or idx >= len(self.ini_entries):
            self.ini_status_label.setText("Cannot save: no section selected.")
            return

        target_section = self.ini_entries[idx]["name"]
        new_fwd = self.ini_value_input.text().strip()
        new_back = self.ini_back_input.text().strip()

        if not new_fwd:
            self.ini_status_label.setText("Cannot save: forward key binding cannot be empty.")
            return

        try:
            try:
                with open(self.selected_ini_path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
            except UnicodeDecodeError:
                with open(self.selected_ini_path, "r", encoding="latin-1") as f:
                    lines = f.readlines()
        except Exception as e:
            self.ini_status_label.setText(f"Cannot read INI: {e}")
            return

        in_target = False
        key_replaced = False
        back_replaced = False
        key_line_pos = -1   # index in new_lines where key= was written
        new_lines = []

        for line in lines:
            stripped = line.strip()
            # Track section changes
            if stripped.startswith("[") and stripped.endswith("]"):
                in_target = (stripped[1:-1] == target_section)

            if in_target:
                # Replace key =
                m = re.match(r'^(\s*key\s*=\s*)(.*)$', line, re.IGNORECASE)
                if m and not key_replaced:
                    new_lines.append(f"{m.group(1)}{new_fwd}\n")
                    key_replaced = True
                    key_line_pos = len(new_lines) - 1
                    continue
                # Replace or remove back =
                m = re.match(r'^(\s*back\s*=\s*)(.*)$', line, re.IGNORECASE)
                if m:
                    if new_back:
                        new_lines.append(f"{m.group(1)}{new_back}\n")
                        back_replaced = True
                    # else: skip line entirely (removes back=)
                    continue

            new_lines.append(line)

        # Insert back= after key= if it didn't exist before but user typed one
        if new_back and not back_replaced and key_line_pos >= 0:
            new_lines.insert(key_line_pos + 1, f"back = {new_back}\n")

        if not key_replaced:
            self.ini_status_label.setText(f"Could not find 'key =' in [{target_section}].")
            return

        try:
            with open(self.selected_ini_path, "w", encoding="utf-8") as f:
                f.writelines(new_lines)
            msg = f"Saved [{target_section}]  key = {new_fwd}"
            if new_back:
                msg += f"  /  back = {new_back}"
            elif self.ini_entries[idx]["back"] and not new_back:
                msg += "  (back removed)"
            self.ini_status_label.setText(msg)
            self.load_ini_for_mod(self.selected_mod_path)
            for i, entry in enumerate(self.ini_entries):
                if entry["name"] == target_section:
                    self.ini_key_list.setCurrentRow(i)
                    self.on_ini_key_changed(i)
                    break
        except Exception as e:
            self.ini_status_label.setText(f"Save failed: {e}")

    # -------------------- THEME --------------------
    def on_theme_changed(self, theme_name):
        """Handle theme dropdown change."""
        if theme_name == "Dark":
            settings["theme"] = "dark"
        elif theme_name == "Light":
            settings["theme"] = "light"
        else:  # Game Theme
            settings["theme"] = "game"
        self.apply_theme()
        save_settings()
        # Recreate items/widgets so per-item styles refresh correctly
        try:
            self.load_items()
        except Exception:
            pass

    def clear_widget_styles(self):
        """Clear inline styles on child widgets to allow stylesheet refresh."""
        try:
            for w in self.findChildren(QWidget):
                try:
                    w.setStyleSheet("")
                except Exception:
                    pass
        except Exception:
            pass

    def apply_theme(self):
        # Clear per-widget inline styles first so global/theme styles apply consistently
        try:
            self.clear_widget_styles()
        except Exception:
            pass
        # Apply global stylesheet for dark or light theme, then update inline widgets
        theme_mode = settings.get("theme", "dark")
        
        if theme_mode == "dark":
            dark_css = """
                QWidget { 
                    background-color: #1a1a1a; 
                    color: #e0e0e0; 
                }
                QMainWindow { 
                    background-color: #1a1a1a; 
                }
                QTabWidget::pane { 
                    background: #1a1a1a; 
                    border: 1px solid #333; 
                }
                QTabBar::tab {
                    background-color: transparent;
                    border: none;
                    border-radius: 8px;
                    padding: 6px 12px;
                    margin: 4px;
                    min-width: 90px;
                    color: #cfcfcf;
                }
                QTabBar::tab:selected {
                    background-color: #0078d4;
                    color: white;
                }
                QTabBar::tab:hover {
                    background-color: rgba(255,255,255,0.03);
                }
                QPushButton {
                    background-color: #0078d4;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    padding: 8px 16px;
                    font-weight: bold;
                }
                QPushButton:hover {
                    background-color: #1084e0;
                }
                QPushButton:pressed {
                    background-color: #005a9e;
                }
                QLineEdit, QComboBox {
                    background-color: #2a2a2a;
                    color: #e0e0e0;
                    border: 1px solid #444;
                    border-radius: 4px;
                    padding: 6px;
                }
                QLineEdit:focus, QComboBox:focus {
                    border: 2px solid #0078d4;
                }
                QListWidget {
                    background-color: #2a2a2a;
                    color: #e0e0e0;
                    border: 1px solid #444;
                    border-radius: 4px;
                }
                QListWidget::item {
                    padding: 6px;
                    margin: 2px;
                    border-radius: 3px;
                }
                QListWidget::item:selected {
                    background-color: #0078d4;
                    color: #ffffff;
                }
                QListWidget::item:hover {
                    background-color: #333;
                }
                QScrollArea { 
                    background-color: #1a1a1a; 
                    border: none;
                }
                QScrollArea::viewport { 
                    background-color: #1a1a1a; 
                }
                QScrollBar:vertical {
                    background-color: #2a2a2a;
                    border: none;
                    width: 12px;
                }
                QScrollBar::handle:vertical {
                    background-color: #555;
                    border-radius: 6px;
                    min-height: 20px;
                }
                QScrollBar::handle:vertical:hover {
                    background-color: #0078d4;
                }
                QLabel { 
                    background-color: transparent; 
                    color: #e0e0e0;
                }
                QCheckBox {
                    color: #e0e0e0;
                }
                QCheckBox::indicator {
                    border: 1px solid #444;
                    border-radius: 3px;
                }
                QCheckBox::indicator:checked {
                    background-color: #0078d4;
                }
            """
            self.setStyleSheet(dark_css)
        elif theme_mode == "light":
            light_css = """
                QWidget { 
                    background-color: #e8e8e8; 
                    color: #222; 
                }
                QMainWindow { 
                    background-color: #e8e8e8; 
                }
                QTabWidget::pane { 
                    background: #e8e8e8; 
                    border: 1px solid #bbb; 
                }
                QTabBar::tab {
                    background-color: transparent;
                    border: none;
                    border-radius: 8px;
                    padding: 6px 12px;
                    margin: 4px;
                    min-width: 90px;
                    color: #444;
                }
                QTabBar::tab:selected {
                    background-color: #0078d4;
                    color: white;
                }
                QTabBar::tab:hover {
                    background-color: rgba(0,0,0,0.08);
                }
                QPushButton {
                    background-color: #0078d4;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    padding: 8px 16px;
                    font-weight: bold;
                }
                QPushButton:hover {
                    background-color: #1084e0;
                }
                QPushButton:pressed {
                    background-color: #005a9e;
                }
                QLineEdit, QComboBox {
                    background-color: #f5f5f5;
                    color: #222;
                    border: 1px solid #bbb;
                    border-radius: 4px;
                    padding: 6px;
                }
                QLineEdit:focus, QComboBox:focus {
                    border: 2px solid #0078d4;
                }
                QListWidget {
                    background-color: #f5f5f5;
                    color: #222;
                    border: 1px solid #bbb;
                    border-radius: 4px;
                }
                QListWidget::item {
                    padding: 6px;
                    margin: 2px;
                    border-radius: 3px;
                }
                QListWidget::item:selected {
                    background-color: #0078d4;
                    color: white;
                }
                QListWidget::item:hover {
                    background-color: #ddd;
                }
                QScrollArea { 
                    background-color: #e8e8e8; 
                    border: none;
                }
                QScrollArea::viewport { 
                    background-color: #e8e8e8; 
                }
                QLabel { 
                    background-color: transparent; 
                    color: #222;
                }
                QCheckBox {
                    color: #222;
                }
            """
            self.setStyleSheet(light_css)
        else:  # Game theme
            # Apply game-specific coloring to tabs and widgets
            self._apply_game_theme()

        # Clear widget-level overrides when not using game theme so global stylesheet applies cleanly
        if theme_mode != "game":
            widget_names = ['btn_add_char','gamebanana_btn','open_folder_btn','toggle_mod_btn','check_updates_btn','update_modmanager_btn','update_installer_btn','prev_img_btn','next_img_btn','mod_list_widget','settings_tab','fixes_tab']
            for name in widget_names:
                try:
                    if hasattr(self, name):
                        getattr(self, name).setStyleSheet("")
                except Exception:
                    pass

        # Update any widgets with inline theme-sensitive styles
        try:
            if hasattr(self, 'preview_label'):
                if theme_mode == "dark":
                    self.preview_label.setStyleSheet("border: 1px solid gray; background-color: #111; color: #ccc;")
                elif theme_mode == "light":
                    self.preview_label.setStyleSheet("border: 1px solid #bbb; background-color: #f5f5f5; color: #222;")
                else:  # game theme
                    # Use tertiary color border and light background for preview in game theme
                    pal_colors = self._get_game_colors(self.selected_game)
                    tertiary = pal_colors['tertiary']
                    bg_light = pal_colors['bg_light']
                    self.preview_label.setStyleSheet(f"border: 2px solid {tertiary}; background-color: {bg_light}; color: #222;")
        except Exception:
            pass
        try:
            if hasattr(self, 'fixes_info'):
                if theme_mode == "dark":
                    info_style = "background-color: #0f0f0f; color: #e0e0e0; border: 1px solid rgba(255,255,255,0.06); padding:6px; border-radius:6px;"
                elif theme_mode == "light":
                    info_style = "background-color: #f5f5f5; color: #222; border: 1px solid #bbb; padding:6px; border-radius:6px;"
                else:  # game theme
                    info_style = "background-color: #0f0f0f; color: #e0e0e0; border: 1px solid rgba(255,255,255,0.06); padding:6px; border-radius:6px;"
                self.fixes_info.setStyleSheet(info_style)
        except Exception:
            pass

        # Additional adjustments for game theme widgets
        if theme_mode == "game":
            pal = self._get_game_colors(self.selected_game)
            primary = pal['primary']
            secondary = pal['secondary']
            tertiary = pal['tertiary']
            bg_light = pal['bg_light']
            bg_dark = pal['bg_dark']
            text = pal['text_light']
            
            # Add Character button with metallic gradient
            try:
                if hasattr(self, 'btn_add_char'):
                    self.btn_add_char.setStyleSheet(f"QPushButton {{ background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {primary}, stop:1 {secondary}); color: white; border: 1px solid {tertiary}; border-radius:4px; padding:8px; font-weight:bold; }} QPushButton:hover {{ background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {secondary}, stop:1 {primary}); }}")
            except Exception:
                pass

            # Common header/action buttons with metallic gradient
            btn_names = ['gamebanana_btn','open_folder_btn','toggle_mod_btn','check_updates_btn','update_modmanager_btn','update_installer_btn','prev_img_btn','next_img_btn']
            try:
                for name in btn_names:
                    if hasattr(self, name):
                        w = getattr(self, name)
                        try:
                            w.setStyleSheet(f"QPushButton {{ background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {primary}, stop:1 {secondary}); color: white; border: 1px solid {tertiary}; border-radius:4px; padding:6px; font-weight:bold; }} QPushButton:hover {{ background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {secondary}, stop:1 {primary}); }}")
                        except Exception:
                            pass
            except Exception:
                pass

            # Mod list and preview area with game theme colors
            try:
                if hasattr(self, 'mod_list_widget'):
                    self.mod_list_widget.setStyleSheet(f"QListWidget {{ background-color: {bg_light}; color: #222; border: 1px solid {tertiary}; }} QListWidget::item:selected {{ background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {primary}, stop:1 {secondary}); color: #fff; }}")
                if hasattr(self, 'preview_label'):
                    self.preview_label.setStyleSheet(f"border: 2px solid {primary}; background-color: {bg_light}; color: #222;")
            except Exception:
                pass

            # Settings and fixes tabs with matching backgrounds
            try:
                if hasattr(self, 'settings_tab'):
                    self.settings_tab.setStyleSheet(f"background-color: {bg_light}; color: #222;")
                if hasattr(self, 'fixes_tab'):
                    self.fixes_tab.setStyleSheet(f"background-color: {bg_light}; color: #222;")
                # Update path labels to use dark text on light backgrounds
                if hasattr(self, 'path_labels'):
                    for k, lbl in self.path_labels.items():
                        try:
                            lbl.setStyleSheet(f"color: #222;")
                        except Exception:
                            pass
            except Exception:
                pass

            # Update any visible warning icons with game accent
            try:
                for it in getattr(self, 'items', []):
                    lbl = it.get('_warning_label')
                    if lbl:
                        lbl.setStyleSheet(f"background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 {primary}, stop:1 {secondary}); color: white; font-weight: bold; font-size: 12px; border-radius: 10px;")
            except Exception:
                pass

    def _get_game_colors(self, game_key=None):
        """Return a rich color palette for the specified game with metallic colors.
        
        Keys: primary (metallic main), secondary (metallic hover), tertiary (accent/border),
              bg_light (light background), bg_dark (dark panels), text_light, text_dark
        """
        palettes = {
            "gi": {  # Genshin Impact - Luxurious gold/bronze with warm tones
                "primary": "#d4af37",      # Bright metallic gold
                "secondary": "#cd7f32",   # Warm bronze
                "tertiary": "#ff8c42",    # Orange accent
                "bg_light": "#e8e3de",    # Warm cream/grey
                "bg_dark": "#2a251f",     # Dark warm brown
                "text_light": "#f5f5f5",
                "text_dark": "#1a1a1a",
            },
            "hsr": {  # Honkai Star Rail - Cosmic silver/platinum
                "primary": "#c0c0c0",     # Metallic silver
                "secondary": "#a0a0a0",  # Platinum
                "tertiary": "#8b5cf6",    # Deep purple
                "bg_light": "#e0e0e0",    # Light silver-grey
                "bg_dark": "#1a0f2e",     # Deep space purple
                "text_light": "#f5f5f5",
                "text_dark": "#1a1a1a",
            },
            "wuwa": {  # Wuthering Waves - Sleek cyan/platinum
                "primary": "#00d9ff",     # Bright cyan metallic
                "secondary": "#00bfdb",  # Teal metallic
                "tertiary": "#b0e0e6",    # Powder blue
                "bg_light": "#d4f1f9",    # Light cyan
                "bg_dark": "#0a1f2e",     # Deep teal
                "text_light": "#f5f5f5",
                "text_dark": "#1a1a1a",
            },
            "zzz": {  # Zenless Zone Zero - Bold red/chrome
                "primary": "#ff3333",     # Bright metallic red
                "secondary": "#cc0000",  # Deep red
                "tertiary": "#ffaa00",   # Gold accent
                "bg_light": "#f5e6e6",    # Light red-grey
                "bg_dark": "#1a0a0a",     # Deep black-red
                "text_light": "#f5f5f5",
                "text_dark": "#1a1a1a",
            },
            "end": {  # Endfield - Nature gold/bronze with forest
                "primary": "#d4af37",     # Metallic gold
                "secondary": "#b8860b",  # Dark goldenrod
                "tertiary": "#228b22",   # Forest green
                "bg_light": "#e8dcc4",    # Light tan
                "bg_dark": "#1a2e1a",     # Forest dark
                "text_light": "#f5f5f5",
                "text_dark": "#1a1a1a",
            },
        }
        k = game_key or self.selected_game or "gi"
        return palettes.get(k, palettes["gi"])

    def _apply_game_theme(self):
        """Apply a richer game-specific theme using multiple palette colors with metallic effects."""
        pal = self._get_game_colors(self.selected_game)
        primary = pal["primary"]
        secondary = pal["secondary"]
        tertiary = pal["tertiary"]
        bg_light = pal["bg_light"]
        bg_dark = pal["bg_dark"]
        text = pal["text_light"]

        # Metallic gradient and shadow effects for depth
        game_css = f"""
            QWidget {{ 
                background-color: {bg_dark};
                color: {text};
            }}
            QMainWindow {{ 
                background-color: {bg_dark};
            }}
            QTabWidget::pane {{ 
                background: {bg_dark}; 
                border: 1px solid {secondary}; 
            }}
            QTabBar::tab {{
                background-color: transparent;
                border: 1px solid rgba(255,255,255,0.05);
                border-radius: 8px;
                padding: 6px 12px;
                margin: 4px;
                min-width: 90px;
                color: {text};
            }}
            QTabBar::tab:selected {{
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {primary}, stop:1 {secondary});
                border: 1px solid {secondary};
                color: white;
                font-weight: bold;
            }}
            QTabBar::tab:hover {{
                background-color: rgba(255,255,255,0.08);
            }}
            QPushButton {{
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {primary}, stop:1 {secondary});
                color: white;
                border: 1px solid {tertiary};
                border-radius: 4px;
                padding: 6px 12px;
                font-weight: bold;
            }}
            QPushButton:hover {{
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {secondary}, stop:1 {primary});
            }}
            QPushButton:pressed {{
                border: 1px inset {tertiary};
            }}
            QLineEdit, QComboBox {{
                background-color: {bg_light};
                color: #222;
                border: 1px solid {tertiary};
                border-radius: 4px;
                padding: 6px;
            }}
            QLineEdit:focus, QComboBox:focus {{
                border: 2px solid {primary};
            }}
            QListWidget {{
                background-color: {bg_light};
                color: #222;
                border: 1px solid {tertiary};
                border-radius: 4px;
            }}
            QListWidget::item {{
                padding: 6px;
                margin: 2px;
                border-radius: 3px;
            }}
            QListWidget::item:selected {{
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {primary}, stop:1 {secondary});
                color: white;
            }}
            QListWidget::item:hover {{
                background-color: {tertiary};
            }}
            QScrollArea {{ 
                background-color: {bg_dark}; 
                border: none;
            }}
            QScrollArea::viewport {{ 
                background-color: {bg_dark}; 
            }}
            QLabel {{ 
                background-color: transparent; 
                color: {text};
            }}
            QCheckBox {{
                color: {text};
            }}
            QCheckBox::indicator:checked {{
                background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 {primary}, stop:1 {secondary});
            }}
        """
        self.setStyleSheet(game_css)


    def on_search_text_changed(self, text):
        """Debounced search text handler."""
        # Cancel previous timer if any
        if self.search_debounce_timer:
            self.search_debounce_timer.stop()
        # Start new timer with 300ms delay
        self.search_debounce_timer = QTimer()
        self.search_debounce_timer.setSingleShot(True)
        self.search_debounce_timer.timeout.connect(lambda: self.search_character(text))
        self.search_debounce_timer.start(300)

    def search_character(self, search_text):
        """Search for a character across all games and categories."""
        # Require at least 2 chars to search
        if not search_text or len(search_text) < 2:
            self.search_results_data = {}
            self.search_results_list.clear()
            self.search_results_list.hide()
            return

        search_text_lower = search_text.lower()
        results_found = False
        self.search_results_data = {}  # Reset data
        self.search_results_list.clear()

        # Search through all games and categories
        for game, game_name in GAMES.items():
            for category in CATEGORIES:
                json_file = os.path.join(RESOURCES, f"{category}_{game}.json")
                if not os.path.exists(json_file):
                    continue
                try:
                    with open(json_file, "r", encoding="utf-8") as f:
                        items = json.load(f)
                        for item in items:
                            name = item.get("name", "") or ""
                            iid = item.get("id", "") or ""
                            if search_text_lower in name.lower() or search_text_lower in iid.lower():
                                display_name = f"{item['name']} ({category})"
                                self.search_results_list.addItem(display_name)
                                self.search_results_data[display_name] = {
                                    "game": game,
                                    "category": category,
                                    "item_id": item["id"],
                                    "item_name": item["name"]
                                }
                                results_found = True
                except Exception:
                    pass

        if results_found:
            self.search_results_list.show()
        else:
            self.search_results_list.hide()

    def on_search_result_selected(self, item):
        """Handle search result selection."""
        try:
            result_text = item.text()
            if result_text not in self.search_results_data:
                return

            result_info = self.search_results_data[result_text]
            target_game = result_info["game"]
            target_category = result_info["category"]
            item_id = result_info["item_id"]

            # Change game
            game_index = self.game_combo.findData(target_game)
            if game_index >= 0:
                self.game_combo.setCurrentIndex(game_index)

            # Change category (match tab text against category)
            cat_index = None
            for idx in range(self.tab_widget.count()):
                if self.tab_widget.tabText(idx).lower() == target_category.lower():
                    cat_index = idx
                    break
            if cat_index is not None:
                self.tab_widget.setCurrentIndex(cat_index)

            # Find and select the item in grid
            grid = self.tabs.get(target_category, {}).get('grid')
            if grid:
                for i in range(grid.count()):
                    widget = grid.itemAt(i).widget()
                    if widget and hasattr(widget, 'character_data'):
                        w_item = widget.character_data.get('item')
                        if w_item and w_item.get('id') == item_id:
                            self.select_item(w_item)
                            break

            # Hide search results
            self.search_results_list.hide()
            self.search_input.clear()
        except Exception as e:
            print(f"Error selecting search result: {e}")

    def auto_update_installer(self):
        """Automatically check and update installer on startup."""
        threading.Thread(target=self._auto_update_installer_thread, daemon=True).start()

    def _auto_update_installer_thread(self):
        """Background thread for auto-update installer."""
        try:
            local_update = os.path.join(BASE_DIR, EXPECTED_UPDATE_EXE_NAME)
            release = fetch_latest_release_info()
            if not release:
                return
            
            assets = release.get("assets", [])
            download_url = None
            for a in assets:
                if a.get("name", "").lower() == EXPECTED_UPDATE_EXE_NAME.lower():
                    download_url = a.get("browser_download_url")
                    break
            
            if not download_url:
                return
            
            # Download to temp location (always attempt; overwrite if exists)
            temp_path = os.path.join(BASE_DIR, "update_new.exe")
            ok = download_url_to_path(download_url, temp_path)
            if ok and os.path.exists(temp_path):
                # Replace old installer
                try:
                    if os.path.exists(local_update):
                        try:
                            os.remove(local_update)
                        except Exception:
                            pass
                    # rename (overwrite)
                    try:
                        os.replace(temp_path, local_update)
                    except Exception:
                        os.rename(temp_path, local_update)
                    print("Installer auto-updated successfully")
                except Exception as e:
                    print(f"Failed to auto-update installer: {e}")
        except Exception as e:
            print(f"Auto-update installer error: {e}")

    def closeEvent(self, event):
        # Save window size
        settings["window_width"] = self.width()
        settings["window_height"] = self.height()
        # Save window position
        try:
            pos = self.pos()
            settings["window_x"] = int(pos.x())
            settings["window_y"] = int(pos.y())
        except Exception:
            pass
        # Save selected game
        settings["last_selected_game"] = self.selected_game
        save_settings()
        try:
            self.observer.stop()
            self.observer.join(timeout=1)
        except Exception:
            pass
        event.accept()

    # -------------------- UPDATE CHECKS & UI --------------------
    def check_updates_manual(self):
        # manual check triggered from settings button
        threading.Thread(target=self._check_updates_and_update_ui, daemon=True).start()

    def check_updates_background(self):
        if settings.get("auto_check_updates", False):
            threading.Thread(target=self._check_updates_and_update_ui, daemon=True).start()
        else:
            # still do one check silently on startup to set dot
            threading.Thread(target=self._check_updates_and_update_ui, daemon=True).start()

    def _check_updates_and_update_ui(self):
        # cancel pending timeout (scheduled on main thread) so it won't override results
        QTimer.singleShot(0, self._cancel_update_timeout)
        try:
            latest = fetch_latest_release_info()
            if not latest:
                # can't fetch - show red
                QTimer.singleShot(0, lambda: self.set_update_status(False, "Unable to check"))
                return
            tag = latest.get("tag_name") or latest.get("name")
            tag_norm = semver_normalize(tag)
            installed = semver_normalize(SCRIPT_VERSION)

            if tag_norm and installed and is_version_newer(installed, tag_norm):
                settings["last_release_tag"] = tag
                save_settings()
                QTimer.singleShot(0, lambda: self.set_update_status(True, f"Update available ({tag})"))
                QTimer.singleShot(0, lambda t=tag: self.prompt_update_now(t))
            else:
                # no update
                settings["last_release_tag"] = tag
                save_settings()
                QTimer.singleShot(0, lambda: self.set_update_status(False, "Up to date"))
        except Exception as e:
            print(f"Error in update check: {e}")
            QTimer.singleShot(0, lambda: self.set_update_status(False, "Error checking"))

    def prompt_update_now(self, tag):
        """Ask user whether to update now when a newer release is available."""
        if not tag:
            return
        if self.update_prompt_open:
            return
        if self.update_prompt_shown_for_tag == tag:
            return

        self.update_prompt_open = True
        try:
            reply = QMessageBox.question(
                self,
                "Update Available",
                f"A newer version ({tag}) is available.\n\nDownload and install it now?",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.Yes
            )
            self.update_prompt_shown_for_tag = tag
            if reply == QMessageBox.StandardButton.Yes:
                self.launch_update_modmanager()
        finally:
            self.update_prompt_open = False

    def set_update_status(self, available: bool, label_text: str):
        # must call from main thread — use QTimer.singleShot to schedule
        def _apply():
            # Always keep visible
            self.update_dot.setVisible(True)
            self.update_label.setVisible(True)
            if available:
                self.update_dot.setStyleSheet("color: #00ff00; font-weight: bold;")  # Green when available
                self.update_label.setStyleSheet("color: #00ff00; font-weight: bold;")
            else:
                self.update_dot.setStyleSheet("color: red; font-weight: bold;")  # Red when not available
                self.update_label.setStyleSheet("color: red; font-weight: bold;")
            self.update_label.setText(label_text)
        QTimer.singleShot(0, _apply)

    def _cancel_update_timeout(self):
        try:
            if hasattr(self, 'update_check_timer') and isinstance(self.update_check_timer, QTimer):
                if self.update_check_timer.isActive():
                    self.update_check_timer.stop()
        except Exception:
            pass

    def start_update_check(self):
        """Start an update check and set a timeout to avoid leaving UI stuck."""
        try:
            # show checking state
            self.update_label.setText("Checking...")
            self.update_dot.setStyleSheet("color: orange; font-weight: bold;")
            threading.Thread(target=self._check_updates_and_update_ui, daemon=True).start()
            # use a named QTimer so we can cancel it when check completes
            self.update_check_timer = QTimer()
            self.update_check_timer.setSingleShot(True)
            self.update_check_timer.timeout.connect(self._update_check_timeout)
            self.update_check_timer.start(15000)
        except Exception as e:
            print(f"Failed to start update check: {e}")

    def _update_check_timeout(self):
        try:
            if self.update_label.text() == "Checking...":
                self.set_update_status(False, "Check timed out")
        except Exception:
            pass

    # -------------------- Update Actions (buttons) --------------------
    def launch_update_modmanager(self):
        """
        Launches the installer/updater exe (update.exe) that will handle downloading modmanager.exe + resources.
        This function will:
        - If update.exe exists in script folder: start it and quit the ModManager.
        - Otherwise attempt to download update.exe from latest GitHub release assets, save as update_new.exe,
          then rename to update.exe and launch it.
        """
        # Determine local update exe path
        local_update_path = os.path.join(BASE_DIR, EXPECTED_UPDATE_EXE_NAME)
        local_update_new_path = os.path.join(BASE_DIR, "update_new.exe")

        # If update_new.exe exists, prefer using it (per your request)
        if os.path.exists(local_update_new_path):
            exe_to_run = local_update_new_path
            # rename into proper update.exe when installer expects? You wanted modmanager to launch the installer
            # We'll launch update_new.exe directly and let installer handle replacement if needed.
        elif os.path.exists(local_update_path):
            exe_to_run = local_update_path
        else:
            # download the update.exe asset from the latest release
            threading.Thread(target=self._download_update_exe_and_launch, daemon=True).start()
            return

        updater_args = [exe_to_run, "--updater", "--install-dir", BASE_DIR]

        # Launch the updater and quit modmanager
        try:
            # spawn updater as detached process
            if sys.platform == "win32":
                # On Windows, CREATE_NEW_CONSOLE/DETACHED_PROCESS could be used; simpler: Popen with shell=False
                subprocess.Popen(updater_args, close_fds=True)
            else:
                subprocess.Popen(updater_args, close_fds=True)
        except Exception as e:
            print("Failed to start updater:", e)
            return

        # close this GUI so updater can take over
        QApplication.quit()
        sys.exit(0)

    def _download_update_exe_and_launch(self):
        release = fetch_latest_release_info()
        if not release:
            print("Could not fetch release to download update.exe")
            return
        assets = release.get("assets", [])
        # find update.exe asset by name expected
        download_url = None
        for a in assets:
            if a.get("name", "").lower() == EXPECTED_UPDATE_EXE_NAME.lower():
                download_url = a.get("browser_download_url")
                break
        if not download_url:
            print("No update.exe asset found in latest release.")
            return

        target = os.path.join(BASE_DIR, "update_new.exe")
        ok = download_url_to_path(download_url, target)
        if not ok:
            print("Failed to download update.exe")
            return

        # Launch the new updater and exit
        try:
            subprocess.Popen([target, "--updater", "--install-dir", BASE_DIR], close_fds=True)
        except Exception as e:
            print("Failed to start downloaded updater:", e)
            return

        QApplication.quit()
        sys.exit(0)

    def update_installer_exe(self):
        """
        Updates the installer executable (update.exe).
        Behavior:
        - If update_new.exe exists locally, use it (rename to update.exe replacing old one).
        - Otherwise download update.exe from GitHub release assets, save as update_new.exe, then swap.
        """
        local_update_new = os.path.join(BASE_DIR, "update_new.exe")
        local_update = os.path.join(BASE_DIR, EXPECTED_UPDATE_EXE_NAME)

        def do_swap():
            try:
                # If update exists, back it up or remove
                if os.path.exists(local_update):
                    try:
                        os.remove(local_update)
                    except Exception:
                        # attempt rename to old
                        try:
                            os.rename(local_update, os.path.join(BASE_DIR, "update_old.exe"))
                        except Exception as e:
                            print("Failed to remove/backup old update.exe:", e)
                # rename downloaded new to update.exe
                if os.path.exists(local_update_new):
                    os.rename(local_update_new, local_update)
                    print("Installer updated.")
                else:
                    print("No update_new.exe found to install.")
            except Exception as e:
                print("Error swapping installer exe:", e)

        # If local update_new exists, just swap immediately
        if os.path.exists(local_update_new):
            do_swap()
            return

        # Otherwise download update.exe and save as update_new.exe
        threading.Thread(target=self._download_installer_and_swap, daemon=True).start()

    def _download_installer_and_swap(self):
        release = fetch_latest_release_info()
        if not release:
            print("Failed to fetch release for installer update")
            return
        assets = release.get("assets", [])
        download_url = None
        for a in assets:
            if a.get("name", "").lower() == EXPECTED_UPDATE_EXE_NAME.lower():
                download_url = a.get("browser_download_url")
                break
        if not download_url:
            print("No update.exe asset found in latest release.")
            return
        target = os.path.join(BASE_DIR, "update_new.exe")
        ok = download_url_to_path(download_url, target)
        if not ok:
            print("Failed to download update_new.exe")
            return
        # now swap
        self.update_installer_exe()

# -------------------- RUN --------------------
if __name__=="__main__":
    app = QApplication(sys.argv)
    window = ModManager()
    window.show()
    sys.exit(app.exec())
