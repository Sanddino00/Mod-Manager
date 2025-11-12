VERSION = "1.0.0"  # Script version

import sys, os, json, shutil, subprocess, zipfile
from urllib.request import urlopen, urlretrieve
from urllib.error import URLError
from PyQt6.QtWidgets import (
    QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout, QPushButton,
    QComboBox, QTabWidget, QGridLayout, QScrollArea, QFrame, QFileDialog, QListWidget, QListWidgetItem
)
from PyQt6.QtGui import QPixmap, QFont
from PyQt6.QtCore import Qt
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

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
GITHUB_REPO = "https://github.com/Sanddino00/Mod-Manager"
GITHUB_TAG = "v.1"

# -------------------- SETTINGS --------------------
if not os.path.exists(SETTINGS_FILE):
    settings = {
        "mod_paths": {
            "gi": os.path.join(BASE_DIR, "gimi", "mods"),
            "hsr": os.path.join(BASE_DIR, "srmi", "mods"),
            "wuwa": os.path.join(BASE_DIR, "wwmi", "mods"),
            "zzz": os.path.join(BASE_DIR, "zzmi", "mods")
        },
        "theme": "dark",
        "notifications_on_startup": True
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
        self.setWindowTitle(f"Mod Manager {VERSION}")
        self.resize(1200,800)
        self.selected_game = "gi"
        self.selected_category = "characters"
        self.selected_item = None
        self.items = []
        self.selected_mod_path = None

        self.observer = Observer()
        self.observer.start()

        self.init_ui()
        self.load_items()

        if settings.get("notifications_on_startup", True):
            self.check_updates_on_startup()

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

        # Update buttons
        self.update_exe_btn = QPushButton("Update EXE")
        self.update_exe_btn.clicked.connect(self.update_exe)
        right_layout.addWidget(self.update_exe_btn)

        self.update_resources_btn = QPushButton("Update Resources")
        self.update_resources_btn.clicked.connect(self.update_resources)
        right_layout.addWidget(self.update_resources_btn)

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

        self.theme_btn = QPushButton("Toggle Theme")
        self.theme_btn.clicked.connect(self.toggle_theme)
        self.settings_layout.addWidget(self.theme_btn)

        # Notification toggle
        self.notify_btn = QPushButton("Toggle Startup Notifications")
        self.notify_btn.clicked.connect(self.toggle_notifications)
        self.settings_layout.addWidget(self.notify_btn)

        self.settings_layout.addStretch()

    def toggle_notifications(self):
        settings["notifications_on_startup"] = not settings.get("notifications_on_startup", True)
        with open(SETTINGS_FILE,"w") as f:
            json.dump(settings,f,indent=2)

    def change_mod_path(self, game):
        folder = QFileDialog.getExistingDirectory(self,f"Select mod folder for {GAMES[game]}")
        if folder:
            settings["mod_paths"][game] = folder
            self.path_labels[game].setText(f"{GAMES[game]}: {folder}")
            with open(SETTINGS_FILE,"w") as f:
                json.dump(settings,f,indent=2)
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
            with open(json_file,"r") as f:
                self.items = json.load(f)
        else:
            self.items = []

        # Auto-create main category subfolders
        base_path = settings["mod_paths"][self.selected_game]
        for item in self.items:
            folder = os.path.join(base_path, self.selected_category, item["id"])
            os.makedirs(folder, exist_ok=True)

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
            pix = QPixmap(icon_path).scaled(100, 100, Qt.AspectRatioMode.KeepAspectRatio)
            icon_label = QLabel()
            icon_label.setPixmap(pix)
            icon_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
            layout.addWidget(icon_label)

        # Name label
        name_label = QLabel(item['name'])
        name_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(name_label)

        # Mod counter label
        counter_label = QLabel()
        counter_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(counter_label)
        item['_counter_label'] = counter_label

        # Warning label for multiple enabled mods
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
            settings["mod_paths"][self.selected_game],
            self.selected_category,
            self.selected_item["id"]
        )
        os.makedirs(char_folder, exist_ok=True)

        # Watch folder
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

    # -------------------- MOD COUNTERS --------------------
    def update_mod_counters(self):
        for item in self.items:
            self.update_mod_counter(item)

    def update_mod_counter(self,item):
        folder_path = os.path.join(settings["mod_paths"][self.selected_game],
                                   self.selected_category, item["id"])
        count = 0
        enabled_count = 0
        if os.path.exists(folder_path):
            subfolders = [f for f in os.listdir(folder_path) if os.path.isdir(os.path.join(folder_path,f))]
            count = len(subfolders)
            enabled_count = len([f for f in subfolders if not f.startswith("DISABLED_")])

        # Update counter
        if '_counter_label' in item:
            item['_counter_label'].setText(f"Mods: {count}")

        # Update warning
        if '_warning_label' in item:
            if self.selected_category == "characters" and enabled_count > 1:
                item['_warning_label'].setText("⚠ More than 1 mod enabled!")
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

    # -------------------- OPEN FOLDER --------------------
    def open_selected_folder(self):
        if not self.selected_item:
            return
        folder = os.path.join(
            settings["mod_paths"][self.selected_game],
            self.selected_category,
            self.selected_item["id"]
        )
        if os.path.exists(folder):
            if sys.platform == "win32":
                os.startfile(folder)
            elif sys.platform == "darwin":
                subprocess.Popen(["open", folder])
            else:
                subprocess.Popen(["xdg-open", folder])

    # -------------------- THEME --------------------
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

    # -------------------- UPDATE CHECK --------------------
    def check_updates_on_startup(self):
        try:
            with urlopen(f"{GITHUB_REPO}/releases/tag/{GITHUB_TAG}") as response:
                if response.status == 200:
                    print("Update available on GitHub!")
        except URLError:
            print("Could not check for updates.")

    def update_resources(self):
        zip_url = f"{GITHUB_REPO}/releases/download/{GITHUB_TAG}/resources.zip"
        zip_path = os.path.join(BASE_DIR,"resources.zip")
        try:
            urlretrieve(zip_url, zip_path)
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(BASE_DIR)
            os.remove(zip_path)
            print("Resources updated successfully!")
        except Exception as e:
            print(f"Failed to update resources: {e}")

    def update_exe(self):
        exe_url = f"{GITHUB_REPO}/releases/download/{GITHUB_TAG}/Mod-Manager.exe"
        exe_path = os.path.join(BASE_DIR,"Mod-Manager_new.exe")
        try:
            urlretrieve(exe_url, exe_path)
            current_exe = sys.executable
            os.replace(exe_path, current_exe)
            subprocess.Popen([current_exe])
            sys.exit()
        except Exception as e:
            print(f"Failed to update EXE: {e}")

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
