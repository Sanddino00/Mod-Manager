import sys, os, json, shutil, subprocess, zipfile
from PyQt6.QtWidgets import (
    QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout, QPushButton,
    QComboBox, QTabWidget, QGridLayout, QScrollArea, QFrame, QFileDialog, QListWidget, QListWidgetItem
)
from PyQt6.QtGui import QPixmap, QFont, QColor
from PyQt6.QtCore import Qt
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

import requests

# -------------------- VERSION --------------------
VERSION = "1.0.2"

# -------------------- BASE DIRECTORY --------------------
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
GITHUB_RELEASES = "https://github.com/Sanddino00/Mod-Manager/releases/download/v.1.0.0/"

# -------------------- SETTINGS --------------------
if not os.path.exists(SETTINGS_FILE):
    settings = {
        "mod_paths": {
            "gi": os.path.join(BASE_DIR, "gimi", "mods"),
            "hsr": os.path.join(BASE_DIR, "srmi", "mods"),
            "wuwa": os.path.join(BASE_DIR, "wwmi", "mods"),
            "zzz": os.path.join(BASE_DIR, "zzmi", "mods")
        },
        "theme": "dark",  # Dark mode default
        "update_check": True
    }
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)
else:
    with open(SETTINGS_FILE, "r") as f:
        settings = json.load(f)

# -------------------- WATCHDOG --------------------
class ModFolderHandler(FileSystemEventHandler):
    def __init__(self, callback):
        self.callback = callback
    def on_any_event(self, event):
        self.callback()

# -------------------- MOD MANAGER GUI --------------------
class ModManager(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"Mod Manager v{VERSION}")
        self.resize(1200,800)
        self.selected_game = "gi"
        self.selected_category = "characters"
        self.selected_item = None
        self.items = []
        self.selected_mod_path = None

        self.observer = Observer()
        self.observer.start()

        self.update_available = False

        self.init_ui()
        self.load_items()
        if settings.get("update_check", True):
            self.check_for_update()

    # -------------------- UI --------------------
    def init_ui(self):
        main_layout = QVBoxLayout()
        self.setLayout(main_layout)

        # Top: Game selection
        top_layout = QHBoxLayout()
        self.game_combo = QComboBox()
        for k,v in GAMES.items():
            self.game_combo.addItem(v,k)
        self.game_combo.currentIndexChanged.connect(lambda _: self.change_game())
        top_layout.addStretch()
        top_layout.addWidget(QLabel("Select Game:"))
        top_layout.addWidget(self.game_combo)
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
        self.path_labels = {}
        for game, name in GAMES.items():
            label = QLabel(f"{name}: {settings['mod_paths'][game]}")
            btn = QPushButton("Change Path")
            btn.clicked.connect(lambda _, g=game: self.change_mod_path(g))
            self.settings_layout.addWidget(label)
            self.settings_layout.addWidget(btn)
            self.path_labels[game] = label

        # Theme toggle
        self.theme_btn = QPushButton("Toggle Theme")
        self.theme_btn.clicked.connect(self.toggle_theme)
        self.settings_layout.addWidget(self.theme_btn)

        # Update notification
        update_layout = QHBoxLayout()
        self.update_dot = QLabel("●")
        self.update_dot.setFixedWidth(15)
        self.update_dot.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.update_dot.setStyleSheet("color: red; font-weight: bold;")
        update_label = QLabel("Update Available")
        update_layout.addWidget(self.update_dot)
        update_layout.addWidget(update_label)
        self.settings_layout.addLayout(update_layout)

        # Update buttons
        self.update_exe_btn = QPushButton("Update EXE")
        self.update_exe_btn.clicked.connect(self.update_exe)
        self.update_resources_btn = QPushButton("Update Resources")
        self.update_resources_btn.clicked.connect(self.update_resources)
        self.settings_layout.addWidget(self.update_exe_btn)
        self.settings_layout.addWidget(self.update_resources_btn)

        self.settings_layout.addStretch()

    # -------------------- MOD PATHS / THEME --------------------
    def change_mod_path(self, game):
        folder = QFileDialog.getExistingDirectory(self,f"Select mod folder for {GAMES[game]}")
        if folder:
            settings["mod_paths"][game] = folder
            self.path_labels[game].setText(f"{GAMES[game]}: {folder}")
            with open(SETTINGS_FILE,"w") as f:
                json.dump(settings,f,indent=2)
            self.load_items()

    def toggle_theme(self):
        settings["theme"] = "dark" if settings["theme"]=="light" else "light"
        self.apply_theme()
        with open(SETTINGS_FILE,"w") as f:
            json.dump(settings,f,indent=2)

    def apply_theme(self):
        if settings["theme"]=="dark":
            self.setStyleSheet("""
                QWidget { background-color: #222; color: #eee; }
                QScrollArea { background-color: #222; }
                QTabWidget::pane { background: #222; }
                QLabel, QPushButton, QComboBox, QListWidget { color: #eee; }
                QListWidget::item:selected { background-color: #555555; color: #ffffff; }
            """)
        else:
            self.setStyleSheet("""
                QWidget { background-color: #d3d3d3; color: #222; }
                QScrollArea { background-color: #d3d3d3; }
                QTabWidget::pane { background: #ccc; }
                QLabel, QPushButton, QComboBox { color: #222; }
                QListWidget { background-color: #444444; color: #ffffff; }
                QListWidget::item:selected { background-color: #666666; color: #ffffff; }
            """)

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
        for i in reversed(range(grid.count())):
            widget = grid.itemAt(i).widget()
            if widget:
                widget.setParent(None)

        json_file = os.path.join(RESOURCES,f"{self.selected_category}_{self.selected_game}.json")
        if os.path.exists(json_file):
            with open(json_file,"r") as f:
                self.items = json.load(f)
        else:
            self.items = []

        base_path = settings["mod_paths"][self.selected_game]
        for item in self.items:
            folder = os.path.join(base_path, self.selected_category, item["id"])
            os.makedirs(folder, exist_ok=True)

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

        icon_path = os.path.join(RESOURCES,"icons",f"{self.selected_game}_{self.selected_category}",f"{item['id']}.png")
        if os.path.exists(icon_path):
            pix = QPixmap(icon_path).scaled(100, 100, Qt.AspectRatioMode.KeepAspectRatio)
            icon_label = QLabel()
            icon_label.setPixmap(pix)
            icon_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
            layout.addWidget(icon_label)

        name_label = QLabel(item['name'])
        name_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(name_label)

        counter_label = QLabel()
        counter_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(counter_label)
        item['_counter_label'] = counter_label

        warning_label = QLabel()
        warning_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        warning_label.setStyleSheet("color: red; font-weight: bold;")
        layout.addWidget(warning_label)
        item['_warning_label'] = warning_label

        self.update_mod_counter(item)
        frame.setFrameShape(QFrame.Shape.Box)
        frame.mousePressEvent = lambda e, i=item: self.select_item(i)
        return frame

    # -------------------- SELECT ITEM / MOD --------------------
    def select_item(self,item):
        self.selected_item = item
        self.load_mods()

    def clear_mod_list(self):
        self.mod_list_widget.clear()
        self.selected_mod_path = None

    def load_mods(self):
        self.clear_mod_list()
        if not self.selected_item:
            return

        char_folder = os.path.join(settings["mod_paths"][self.selected_game], self.selected_category, self.selected_item["id"])
        os.makedirs(char_folder, exist_ok=True)

        self.observer.unschedule_all()
        self.observer.schedule(ModFolderHandler(self.load_mods), char_folder, recursive=True)

        mods = []
        for f in os.listdir(char_folder):
            full_path = os.path.join(char_folder, f)
            if os.path.isdir(full_path):
                disabled = f.startswith("DISABLED_")
                display_name = f.replace("DISABLED_", "")
                mods.append({"name": f, "display": display_name, "disabled": disabled, "path": full_path})

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

    def select_mod(self,list_item):
        self.selected_mod_path = list_item.data(Qt.ItemDataRole.UserRole)
        for i in range(self.mod_list_widget.count()):
            self.mod_list_widget.item(i).setBackground(Qt.GlobalColor.transparent)
        list_item.setBackground(Qt.GlobalColor.lightGray)

    def toggle_selected_mod(self):
        if not self.selected_mod_path or not os.path.exists(self.selected_mod_path):
            return
        parent_folder = os.path.dirname(self.selected_mod_path)
        folder_name = os.path.basename(self.selected_mod_path)
        if folder_name.startswith("DISABLED_"):
            new_name = folder_name.replace("DISABLED_", "")
        else:
            new_name = f"DISABLED_{folder_name}"
        new_path = os.path.join(parent_folder, new_name)
        try:
            os.rename(self.selected_mod_path, new_path)
            self.selected_mod_path = new_path
        except Exception as e:
            print(f"Failed to rename folder: {e}")
        self.load_mods()

    # -------------------- MOD COUNTERS --------------------
    def update_mod_counters(self):
        for item in self.items:
            self.update_mod_counter(item)

    def update_mod_counter(self,item):
        folder_path = os.path.join(settings["mod_paths"][self.selected_game], self.selected_category, item["id"])
        count = 0
        enabled_count = 0
        if os.path.exists(folder_path):
            subfolders = [f for f in os.listdir(folder_path) if os.path.isdir(os.path.join(folder_path,f))]
            count = len(subfolders)
            enabled_count = len([f for f in subfolders if not f.startswith("DISABLED_")])
        if '_counter_label' in item:
            item['_counter_label'].setText(f"Mods: {count}")
        if '_warning_label' in item:
            if enabled_count > 1:
                item['_warning_label'].setText("⚠ More than 1 mod enabled!")
            else:
                item['_warning_label'].setText("")

    # -------------------- OPEN FOLDER --------------------
    def open_selected_folder(self):
        if not self.selected_item:
            return
        folder = os.path.join(settings["mod_paths"][self.selected_game], self.selected_category, self.selected_item["id"])
        if os.path.exists(folder):
            if sys.platform == "win32":
                os.startfile(folder)
            elif sys.platform == "darwin":
                subprocess.Popen(["open", folder])
            else:
                subprocess.Popen(["xdg-open", folder])

    # -------------------- UPDATE CHECK --------------------
    def check_for_update(self):
        try:
            releases = requests.get("https://api.github.com/repos/Sanddino00/Mod-Manager/releases").json()
            latest_tag = releases[0]['tag_name']
            if latest_tag != f"v.{VERSION}":
                self.update_available = True
                self.update_dot.setStyleSheet("color: green; font-weight: bold;")
            else:
                self.update_available = False
                self.update_dot.setStyleSheet("color: red; font-weight: bold;")
        except Exception as e:
            print(f"Update check failed: {e}")
            self.update_available = False
            self.update_dot.setStyleSheet("color: red; font-weight: bold;")

    # -------------------- UPDATE FUNCTIONS --------------------
    def update_resources(self):
        try:
            url = GITHUB_RELEASES + "resources.zip"
            r = requests.get(url, stream=True)
            zip_path = os.path.join(BASE_DIR,"resources.zip")
            with open(zip_path,"wb") as f:
                shutil.copyfileobj(r.raw, f)
            # Extract
            with zipfile.ZipFile(zip_path,"r") as zip_ref:
                zip_ref.extractall(BASE_DIR)
            os.remove(zip_path)
            self.load_items()
        except Exception as e:
            print(f"Failed updating resources: {e}")

    def update_exe(self):
        try:
            url = GITHUB_RELEASES + "modmanager.exe"
            exe_path = os.path.join(BASE_DIR,"modmanager_new.exe")
            r = requests.get(url, stream=True)
            with open(exe_path,"wb") as f:
                shutil.copyfileobj(r.raw,f)
            # Replace old exe
            old_exe = sys.executable
            os.rename(old_exe, old_exe+".bak")
            os.rename(exe_path, old_exe)
            subprocess.Popen([old_exe])
            sys.exit(0)
        except Exception as e:
            print(f"Failed updating exe: {e}")

    # -------------------- CLOSE --------------------
    def closeEvent(self,event):
        self.observer.stop()
        self.observer.join()
        event.accept()

# -------------------- RUN --------------------
if __name__=="__main__":
    app = QApplication(sys.argv)
    window = ModManager()
    window.show()
    sys.exit(app.exec())
