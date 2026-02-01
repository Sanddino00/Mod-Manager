# Version 1.2.1
# modmanager.py - Mod Manager GUI with update checks and settings
# NOTE: Designed to be run with Python 3.10+ and PyQt6 installed.
# Uses only stdlib network (urllib) to avoid extra pip deps for update check.

import sys
import os
import json
import shutil
import subprocess
import threading
import urllib.request
import urllib.error
import zipfile
import tempfile
import webbrowser
from packaging import version as pkg_version  # packaging is often available; fallback handled below
from PyQt6.QtWidgets import (
    QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout, QPushButton,
    QComboBox, QTabWidget, QGridLayout, QScrollArea, QFrame, QFileDialog,
    QListWidget, QListWidgetItem, QCheckBox, QMessageBox, QLineEdit, QTextEdit,
    QInputDialog, QSizePolicy
)
from PyQt6.QtGui import QPixmap, QFont
from PyQt6.QtCore import Qt, QTimer
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# -------------------- Version & BASE DIRECTORY --------------------
SCRIPT_VERSION = "1.2.1"  # keep in sync with settings default "version"

if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

RESOURCES = os.path.join(BASE_DIR, "resources")
os.makedirs(RESOURCES, exist_ok=True)
SETTINGS_FILE = os.path.join(RESOURCES, "settings.json")

# -------------------- CONFIG --------------------
GAMES = {"gi": "Genshin Impact", "hsr": "Honkai Star Rail", "wuwa": "Wuthering Waves", "zzz": "Zenless Zone Zero"}
GAMEBANANA_URLS = {
    "gi": "https://gamebanana.com/games/8552",
    "hsr": "https://gamebanana.com/games/18366",
    "wuwa": "https://gamebanana.com/games/20357",
    "zzz": "https://gamebanana.com/games/19567",
}
RABBITFX_URLS = {
    "wuwa": "https://gamebanana.com/mods/527815",
    "hsr": "https://gamebanana.com/mods/608041",
    "zzz": "https://gamebanana.com/mods/531649",
}
CATEGORIES = ["characters", "weapons", "ui", "objects", "npcs"]

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
    "zzz": os.path.join(BASE_DIR, "zzmi", "mods")
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
        self.mod_manager = None  # Will be set by ModManager
    
    def dragEnterEvent(self, event):
        """Accept drag if it contains files/folders."""
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            super().dragEnterEvent(event)
    
    def dropEvent(self, event):
        """Handle dropping folders/files from file explorer."""
        try:
            if event.mimeData().hasUrls():
                for url in event.mimeData().urls():
                    path = url.toLocalFile()
                    if os.path.isdir(path) and self.mod_manager:
                        # Copy the dropped folder to current character's mod folder
                        self.mod_manager.import_mod_from_path(path)
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

def semver_normalize(tag):
    """Strip leading 'v' and return normalized semver string."""
    if not tag:
        return None
    t = tag.strip()
    if t.startswith("v") or t.startswith("V"):
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

def find_all_images_recursive(folder_path):
    """Return a list of all image file paths inside folder and subfolders."""
    image_paths = []
    for root, dirs, files in os.walk(folder_path):
        for f in files:
            if f.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp', '.gif')):
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
        self.search_results_data = {}  # Store search results for navigation
        self.search_debounce_timer = None  # Debounce timer for search
        self.resize_debounce_timer = None  # Debounce timer for resize

        self.observer = Observer()
        self.observer.start()

        self.init_ui()
        # load items and start background update check
        self.load_items()
        QTimer.singleShot(500, self.start_update_check)
        QTimer.singleShot(1000, self.auto_update_installer)

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

        # Center layout
        center_layout = QHBoxLayout()

        # Left: Tabs for categories + settings
        self.tab_widget = QTabWidget()
        self.tab_widget.setTabPosition(QTabWidget.TabPosition.West)
        self.tabs = {}
        for cat in CATEGORIES:
            tab = QWidget()
            scroll = QScrollArea()
            scroll.setWidgetResizable(True)
            content = QWidget()
            grid = QGridLayout()
            content.setLayout(grid)
            scroll.setWidget(content)
            layout = QVBoxLayout()
            
            # Add button for characters category
            if cat == "characters":
                btn_add_char = QPushButton("➕ Add Character")
                btn_add_char.setStyleSheet("""
                    QPushButton {
                        background-color: #0078d4;
                        color: white;
                        border-radius: 4px;
                        padding: 8px;
                        font-weight: bold;
                    }
                    QPushButton:hover {
                        background-color: #1084e0;
                    }
                """)
                btn_add_char.clicked.connect(self.add_new_character)
                layout.addWidget(btn_add_char)
            
            layout.addWidget(scroll)
            tab.setLayout(layout)
            self.tab_widget.addTab(tab, cat.capitalize())
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
        center_layout.addWidget(self.tab_widget,2)

        # Right: Mods and Preview
        right_layout = QVBoxLayout()
        self.open_folder_btn = QPushButton("Open Folder")
        self.open_folder_btn.clicked.connect(self.open_selected_folder)
        right_layout.addWidget(self.open_folder_btn)
                # ---------- Add Preview QLabel ----------
        # ---------- Preview Setup ----------
        self.preview_label = QLabel("No preview available")
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview_label.setFixedHeight(250)  # adjust height as needed
        self.preview_label.setStyleSheet(
            "border: 1px solid gray; background-color: #111; color: #ccc;"
        )
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

        # Add the horizontal layout to the right_layout
        right_layout.addLayout(preview_layout)


        # Enable/Disable button
        self.toggle_mod_btn = QPushButton("Enable/Disable Selected Mod")
        self.toggle_mod_btn.clicked.connect(self.toggle_selected_mod)
        right_layout.addWidget(self.toggle_mod_btn)

        self.mod_list_widget = ModListWidget()
        self.mod_list_widget.setSelectionMode(QListWidget.SelectionMode.SingleSelection)
        self.mod_list_widget.itemClicked.connect(self.select_mod)
        self.mod_list_widget.mod_manager = self
        right_layout.addWidget(self.mod_list_widget, 1)
        

        
        center_layout.addLayout(right_layout,1)

        main_layout.addLayout(center_layout)
        self.apply_theme()

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

        # Theme toggle
        self.theme_btn = QPushButton("Toggle Theme")
        self.theme_btn.clicked.connect(self.toggle_theme)
        self.settings_layout.addWidget(self.theme_btn)

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
        if settings.get("theme", "dark") == "dark":
            info_style = "background-color: #0f0f0f; color: #e0e0e0; border: 1px solid rgba(255,255,255,0.06); padding:6px; border-radius:6px;"
        else:
            info_style = "background-color: #ffffff; color: #111; border: 1px solid rgba(0,0,0,0.08); padding:6px; border-radius:6px;"
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
        folder = QFileDialog.getExistingDirectory(self, "Select Target Folder")
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
            save_settings()
            self.load_items()

    # -------------------- GAME / CATEGORY --------------------
    def change_game(self):
        self.selected_game = self.game_combo.currentData()
        settings["last_selected_game"] = self.selected_game
        save_settings()
        self.load_items()
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
        if index < len(CATEGORIES):
            self.selected_category = CATEGORIES[index]
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

        # Sort items: favorites first, then by name
        favorites = settings.get("favorites", {}).get(self.selected_game, [])
        self.items.sort(key=lambda x: (x["id"] not in favorites, x.get("name", "")))

        # Create main category folder if needed (ask user first)
        base_path = settings["mod_paths"].get(self.selected_game, default_mod_paths[self.selected_game])
        main_cat_folder = os.path.join(base_path, self.selected_category)
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
        if os.path.exists(main_cat_folder):
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
        layout = QVBoxLayout()
        frame.setLayout(layout)
        
        # Store item data on frame for drag/drop
        frame.character_data = {"game": self.selected_game, "category": self.selected_category, "item": item}

        # Modern styling for the frame (theme-aware)
        frame.setFrameShape(QFrame.Shape.Box)
        if settings.get("theme", "dark") == "dark":
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
        
        # Top row: Favorite button + warning
        top_row = QHBoxLayout()
        top_row.setContentsMargins(0, 0, 0, 5)
        fav_btn = QPushButton()
        fav_btn.setMaximumWidth(30)
        fav_btn.setMaximumHeight(30)
        favorites = settings.get("favorites", {}).get(self.selected_game, [])
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

        # Warning label (placed next to favorite) - hidden by default
        warning_label = QLabel()
        warning_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        # Theme-aware color and transparent background to avoid dark/black patches
        if settings.get("theme", "dark") == "dark":
            warn_color = "#ff6b6b"
        else:
            warn_color = "#b00020"
        warning_label.setStyleSheet(f"background-color: transparent; color: {warn_color}; font-weight: bold; font-size: 12px;")
        warning_label.setMaximumHeight(0)
        warning_label.setContentsMargins(4, 0, 6, 0)

        top_row.addWidget(fav_btn)
        top_row.addWidget(warning_label)
        top_row.addStretch()
        layout.addLayout(top_row)

        # Icon
        icon_path = os.path.join(
            RESOURCES,
            "icons",
            f"{self.selected_game}_{self.selected_category}",
            f"{item['id']}.png"
        )
        if os.path.exists(icon_path):
            try:
                pix = QPixmap(icon_path).scaled(100, 100, Qt.AspectRatioMode.KeepAspectRatio)
                icon_label = QLabel()
                icon_label.setPixmap(pix)
                icon_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
                layout.addWidget(icon_label)
            except Exception:
                pass

        # Name label with modern styling
        name_label = QLabel(item['name'])
        name_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        name_label.setStyleSheet("color: #fff; font-weight: bold; font-size: 11px;")
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
            
        settings.setdefault("favorites", {})
        settings["favorites"].setdefault(self.selected_game, [])
        
        if item["id"] in settings["favorites"][self.selected_game]:
            settings["favorites"][self.selected_game].remove(item["id"])
        else:
            settings["favorites"][self.selected_game].append(item["id"])
        
        save_settings()
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
                self.selected_category,
                self.selected_item["id"]
            )

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
        else:
            content = tab_data.get("content")
            available_width = content.width() if content and content.width() > 0 else tab_data.get("scroll").width()
            item_width = 220
            cols = max(1, available_width // item_width)

        row = 0
        col = 0
        for item in self.items:
            btn = self.create_item_widget(item)
            grid.addWidget(btn, row, col)
            col += 1
            if col >= cols:
                col = 0
                row += 1

        # set stretch for responsiveness
        for c in range(max(3, cols)):
            grid.setColumnStretch(c, 1)
        for r in range(row + 1):
            grid.setRowStretch(r, 0)

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
        except Exception:
            pass

    # -------------------- SELECT ITEM --------------------
    def select_item(self,item):
        self.selected_item = item
        self.load_mods()

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

    def load_mods(self):
        self.clear_mod_list()
        if not self.selected_item:
            return

        char_folder = os.path.join(
            settings["mod_paths"].get(self.selected_game, default_mod_paths[self.selected_game]),
            self.selected_category,
            self.selected_item["id"]
        )
        
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
            self.observer.schedule(ModFolderHandler(self.load_mods), char_folder, recursive=True)
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

        self.update_mod_counters()

    # -------------------- MOD COUNTERS --------------------
    def update_mod_counters(self):
        for item in self.items:
            self.update_mod_counter(item)

    def update_mod_counter(self,item):
        folder_path = os.path.join(settings["mod_paths"].get(self.selected_game, default_mod_paths[self.selected_game]),
                                   self.selected_category, item["id"])
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

        # Update warning only for characters - show/hide based on content
        if '_warning_label' in item:
            if self.selected_category == "characters":
                if enabled_count > 1:
                    item['_warning_label'].setText("⚠ More than 1 mod enabled!")
                    item['_warning_label'].setMaximumHeight(20)  # Show
                else:
                    item['_warning_label'].setText("")
                    item['_warning_label'].setMaximumHeight(0)  # Hide
            else:
                item['_warning_label'].setText("")
                item['_warning_label'].setMaximumHeight(0)  # Hide

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

        except Exception as e:
            print(f"Error selecting mod: {e}")

        # -------------------- SHOW MOD PREVIEW --------------------
    def show_mod_preview(self, mod_folder_path):
        """Display images from mod folder (including subfolders) with navigation."""
        try:
            self.preview_images = find_all_images_recursive(mod_folder_path)
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
        img_path = self.preview_images[self.preview_index]
        pix = QPixmap(img_path).scaled(
            self.preview_label.width(),
            self.preview_label.height(),
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation
        )
        self.preview_label.setPixmap(pix)
    
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
            self.selected_category,
            self.selected_item["id"]
        )
        if os.path.exists(folder):
            open_folder(folder)

    # -------------------- THEME --------------------
    def toggle_theme(self):
        settings["theme"] = "dark" if settings.get("theme","dark")=="light" else "light"
        self.apply_theme()
        save_settings()

    def apply_theme(self):
        if settings.get("theme","dark")=="dark":
            # Modern dark theme inspired by IMM/JASM
            self.setStyleSheet("""
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
            """)
        else:
            # Modern light theme
            self.setStyleSheet("""
                QWidget { 
                    background-color: #f5f5f5; 
                    color: #222; 
                }
                QMainWindow { 
                    background-color: #f5f5f5; 
                }
                QTabWidget::pane { 
                    background: #f5f5f5; 
                    border: 1px solid #ddd; 
                }
                QTabBar::tab {
                    background-color: transparent;
                    border: none;
                    border-radius: 8px;
                    padding: 6px 12px;
                    margin: 4px;
                    min-width: 90px;
                    color: #555;
                }
                QTabBar::tab:selected {
                    background-color: #0078d4;
                    color: white;
                }
                QTabBar::tab:hover {
                    background-color: rgba(0,0,0,0.04);
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
                    background-color: white;
                    color: #222;
                    border: 1px solid #ddd;
                    border-radius: 4px;
                    padding: 6px;
                }
                QLineEdit:focus, QComboBox:focus {
                    border: 2px solid #0078d4;
                }
                QListWidget {
                    background-color: white;
                    color: #222;
                    border: 1px solid #ddd;
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
                    background-color: #e8e8e8;
                }
                QScrollArea { 
                    background-color: #f5f5f5; 
                    border: none;
                }
                QScrollArea::viewport { 
                    background-color: #f5f5f5; 
                }
                QLabel { 
                    background-color: transparent; 
                    color: #222;
                }
                QCheckBox {
                    color: #222;
                }
            """)

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
            
            # Download to temp location
            temp_path = os.path.join(BASE_DIR, "update_new.exe")
            if not os.path.exists(temp_path):
                ok = download_url_to_path(download_url, temp_path)
                if ok and os.path.exists(temp_path):
                    # Replace old installer
                    try:
                        if os.path.exists(local_update):
                            os.remove(local_update)
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
            else:
                # no update
                settings["last_release_tag"] = tag
                save_settings()
                QTimer.singleShot(0, lambda: self.set_update_status(False, "Up to date"))
        except Exception as e:
            print(f"Error in update check: {e}")
            QTimer.singleShot(0, lambda: self.set_update_status(False, "Error checking"))

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

        # Launch the updater and quit modmanager
        try:
            # spawn updater as detached process
            if sys.platform == "win32":
                # On Windows, CREATE_NEW_CONSOLE/DETACHED_PROCESS could be used; simpler: Popen with shell=False
                subprocess.Popen([exe_to_run], close_fds=True)
            else:
                subprocess.Popen([exe_to_run], close_fds=True)
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
            subprocess.Popen([target], close_fds=True)
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
