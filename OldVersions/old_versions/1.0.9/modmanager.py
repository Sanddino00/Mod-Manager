# Version 1.0.9
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
from packaging import version as pkg_version  # packaging is often available; fallback handled below
from PyQt6.QtWidgets import (
    QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout, QPushButton,
    QComboBox, QTabWidget, QGridLayout, QScrollArea, QFrame, QFileDialog,
    QListWidget, QListWidgetItem, QCheckBox
)
from PyQt6.QtGui import QPixmap, QFont
from PyQt6.QtCore import Qt, QTimer
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# -------------------- Version & BASE DIRECTORY --------------------
SCRIPT_VERSION = "1.0.9"  # keep in sync with settings default "version"

if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

RESOURCES = os.path.join(BASE_DIR, "resources")
os.makedirs(RESOURCES, exist_ok=True)
SETTINGS_FILE = os.path.join(RESOURCES, "settings.json")

# -------------------- CONFIG --------------------
GAMES = {"gi": "Genshin Impact", "hsr": "Honkai Star Rail", "wuwa": "Wuthering Waves", "zzz": "Zenless Zone Zero"}
CATEGORIES = ["characters", "weapons", "ui", "objects", "npcs"]

GITHUB_RELEASES_API = "https://api.github.com/repos/Sanddino00/Mod-Manager/releases/latest"
# expected filenames in release:
EXPECTED_UPDATE_EXE_NAME = "update.exe"      # name of the installer/updater exe in releases
EXPECTED_RESOURCES_ZIP_NAME = "resources.zip"  # name of resources zip in releases
EXPECTED_MODMANAGER_EXE_NAME = "modmanager.exe"

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
        "version": SCRIPT_VERSION,
        "auto_check_updates": False,
        "last_release_tag": None,
        "install_path_info": None  # path storage for installer/updater if needed
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
                "version": SCRIPT_VERSION,
                "auto_check_updates": False,
                "last_release_tag": None,
                "install_path_info": None
            }

# -------------------- WATCHDOG --------------------
class ModFolderHandler(FileSystemEventHandler):
    def __init__(self, callback):
        self.callback = callback
    def on_any_event(self, event):
        # ignore temporary events
        self.callback()

# -------------------- UTILITIES --------------------
def save_settings():
    try:
        with open(SETTINGS_FILE, "w") as f:
            json.dump(settings, f, indent=2)
    except Exception as e:
        print("Failed to save settings:", e)

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
        self.resize(1200,800)
        self.selected_game = "gi"
        self.selected_category = "characters"
        self.selected_item = None
        self.items = []
        self.selected_mod_path = None

        self.observer = Observer()
        self.observer.start()

        self.init_ui()
        # load items and start background update check
        self.load_items()
        QTimer.singleShot(500, self.check_updates_background)

    # -------------------- UI --------------------
    def init_ui(self):
        main_layout = QVBoxLayout()
        self.setLayout(main_layout)

        # Top: Game selection + update dot
        top_layout = QHBoxLayout()
        self.game_combo = QComboBox()
        for k,v in GAMES.items():
            self.game_combo.addItem(v,k)
        self.game_combo.setCurrentIndex(list(GAMES.keys()).index(self.selected_game))
        self.game_combo.currentIndexChanged.connect(lambda _: self.change_game())

        top_layout.addStretch()
        top_layout.addWidget(QLabel("Select Game:"))
        top_layout.addWidget(self.game_combo)

        # Update dot + label (moved next to game selection)
        self.update_dot = QLabel("●")  # colored dot via stylesheet
        self.update_dot.setFixedWidth(12)
        self.update_dot.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.update_dot.setStyleSheet("color: red; font-weight: bold;")
        self.update_label = QLabel("Update available")
        self.update_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        # start hidden until check runs
        self.update_dot.setVisible(True)
        self.update_label.setVisible(True)

        top_layout.addWidget(self.update_dot)
        top_layout.addWidget(self.update_label)
        top_layout.addStretch()
        main_layout.addLayout(top_layout)

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
            layout.addWidget(scroll)
            tab.setLayout(layout)
            self.tab_widget.addTab(tab, cat.capitalize())
            self.tabs[cat] = {"tab": tab, "grid": grid, "scroll": scroll, "content": content}

        # Settings tab
        self.settings_tab = QWidget()
        self.settings_layout = QVBoxLayout()
        self.settings_tab.setLayout(self.settings_layout)
        self.tab_widget.addTab(self.settings_tab, "Settings")
        self.create_settings_tab()

        self.tab_widget.currentChanged.connect(self.tab_changed)
        center_layout.addWidget(self.tab_widget,2)

        # Right: Mods
        right_layout = QVBoxLayout()
        self.open_folder_btn = QPushButton("Open Folder")
        self.open_folder_btn.clicked.connect(self.open_selected_folder)
        right_layout.addWidget(self.open_folder_btn)

        # Enable/Disable button
        self.toggle_mod_btn = QPushButton("Enable/Disable Selected Mod")
        self.toggle_mod_btn.clicked.connect(self.toggle_selected_mod)
        right_layout.addWidget(self.toggle_mod_btn)

        self.mod_list_widget = QListWidget()
        self.mod_list_widget.setSelectionMode(QListWidget.SelectionMode.SingleSelection)
        self.mod_list_widget.itemClicked.connect(self.select_mod)
        right_layout.addWidget(self.mod_list_widget)
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

        # Spacer
        self.settings_layout.addStretch()

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
        self.load_items()

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

        # Auto-create main category subfolders
        base_path = settings["mod_paths"].get(self.selected_game, default_mod_paths[self.selected_game])
        for item in self.items:
            folder = os.path.join(base_path, self.selected_category, item["id"])
            try:
                os.makedirs(folder, exist_ok=True)
            except Exception:
                pass

        # populate grid
        row=0; col=0
        for item in self.items:
            btn = self.create_item_widget(item)
            grid.addWidget(btn,row,col)
            col += 1
            if col >= 3:
                col=0
                row+=1

    # -------------------- ITEM WIDGET --------------------
    def create_item_widget(self,item):
        frame = QFrame()
        layout = QVBoxLayout()
        frame.setLayout(layout)

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

        # Name label
        name_label = QLabel(item['name'])
        name_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(name_label)

        # Mod counter label
        counter_label = QLabel()
        counter_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(counter_label)
        item['_counter_label'] = counter_label

        # Warning label for multiple enabled mods (only characters/weapons)
        warning_label = QLabel()
        warning_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        warning_label.setStyleSheet("color: red; font-weight: bold;")
        layout.addWidget(warning_label)
        item['_warning_label'] = warning_label

        self.update_mod_counter(item)

        # Click to select
        frame.setFrameShape(QFrame.Shape.Box)
        frame.mousePressEvent = lambda e, i=item: self.select_item(i)

        return frame

    # -------------------- SELECT ITEM --------------------
    def select_item(self,item):
        self.selected_item = item
        self.load_mods()

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
        os.makedirs(char_folder, exist_ok=True)

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

        # Update warning only for characters and weapons
        if '_warning_label' in item:
            if self.selected_category in ("characters", "weapons"):
                if enabled_count > 1:
                    item['_warning_label'].setText("⚠ More than 1 mod enabled!")
                else:
                    item['_warning_label'].setText("")
            else:
                item['_warning_label'].setText("")

    # -------------------- SELECT MOD --------------------
    def select_mod(self,list_item):
        self.selected_mod_path = list_item.data(Qt.ItemDataRole.UserRole)
        # Highlight selection
        for i in range(self.mod_list_widget.count()):
            self.mod_list_widget.item(i).setBackground(Qt.GlobalColor.transparent)
        list_item.setBackground(Qt.GlobalColor.lightGray)

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
            self.setStyleSheet("""
                QWidget { background-color: #222; color: #eee; }
                QScrollArea { background-color: #222; }
                QTabWidget::pane { background: #222; }
                QLabel, QPushButton, QComboBox, QListWidget { color: #eee; }
                QListWidget::item:selected { background-color: #555555; color: #ffffff; }
            """)
        else:
            self.setStyleSheet("""
                QWidget { background-color: #d3d3d3; color: #222; }  /* Light gray background */
                QScrollArea { background-color: #d3d3d3; }
                QTabWidget::pane { background: #ccc; }
                QLabel, QPushButton, QComboBox { color: #222; }
                QListWidget { background-color: #444444; color: #ffffff; } /* Dark gray mod list */
                QListWidget::item:selected { background-color: #666666; color: #ffffff; }
            """)

    def closeEvent(self,event):
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
        latest = fetch_latest_release_info()
        if not latest:
            # can't fetch - show red
            self.set_update_status(False, "Unable to check")
            return
        tag = latest.get("tag_name") or latest.get("name")
        tag_norm = semver_normalize(tag)
        installed = semver_normalize(settings.get("version", SCRIPT_VERSION))
        if tag_norm and installed and is_version_newer(installed, tag_norm):
            settings["last_release_tag"] = tag
            save_settings()
            self.set_update_status(True, f"Update available ({tag})")
        else:
            # no update
            settings["last_release_tag"] = tag
            save_settings()
            self.set_update_status(False, "Up to date")

    def set_update_status(self, available: bool, label_text: str):
        # must call from main thread — use QTimer.singleShot to schedule
        def _apply():
            if available:
                self.update_dot.setStyleSheet("color: green; font-weight: bold;")
            else:
                self.update_dot.setStyleSheet("color: red; font-weight: bold;")
            self.update_label.setText(label_text)
        QTimer.singleShot(0, _apply)

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
