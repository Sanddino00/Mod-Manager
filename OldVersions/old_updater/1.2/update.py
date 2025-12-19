import os, sys, json, shutil, zipfile, requests, subprocess
from PyQt6.QtWidgets import QApplication, QWidget, QVBoxLayout, QLabel, QPushButton, QFileDialog, QProgressBar, QMessageBox, QCheckBox
from PyQt6.QtCore import Qt

# -------------------- CONFIG --------------------
GITHUB_RELEASES = "https://github.com/Sanddino00/Mod-Manager/releases/latest/download"
MODMANAGER_EXE = "modmanager.exe"
RESOURCES_ZIP = "resources.zip"
UPDATE_EXE = "update.exe"
UPDATE_NEW_EXE = "update_new.exe"
INSTALL_JSON = "install_path.json"
DESKTOP = os.path.join(os.path.join(os.environ['USERPROFILE']), 'Desktop')

# -------------------- HELPERS --------------------
def download_file(url, path, progress_callback=None):
    r = requests.get(url, stream=True)
    total_length = int(r.headers.get('content-length', 0))
    with open(path, 'wb') as f:
        dl = 0
        for data in r.iter_content(chunk_size=4096):
            f.write(data)
            dl += len(data)
            if progress_callback:
                progress_callback(int(dl / total_length * 100))

def unzip_and_merge(zip_path, extract_to):
    with zipfile.ZipFile(zip_path, 'r') as zip_ref:
        zip_ref.extractall(extract_to)
    nested_resources = os.path.join(extract_to, 'resources')
    final_resources = os.path.join(extract_to, 'resources')
    if os.path.exists(nested_resources):
        for item in os.listdir(nested_resources):
            src = os.path.join(nested_resources, item)
            dst = os.path.join(final_resources, item)
            if os.path.exists(dst):
                if os.path.isdir(dst):
                    shutil.rmtree(dst)
                else:
                    os.remove(dst)
            shutil.move(src, dst)
        if nested_resources != final_resources:
            os.rmdir(nested_resources)

def close_modmanager_win():
    try:
        subprocess.run(["taskkill", "/f", "/im", MODMANAGER_EXE], check=True)
    except Exception as e:
        print(f"Failed to close {MODMANAGER_EXE}: {e}")

def create_shortcut(exe_path):
    try:
        import pythoncom
        from win32com.shell import shell, shellcon
        pythoncom.CoInitialize()
        shortcut_path = os.path.join(DESKTOP, "Mod-Manager.lnk")
        shortcut = shell.CreateShortcut(shortcut_path)
        shortcut.TargetPath = exe_path
        shortcut.WorkingDirectory = os.path.dirname(exe_path)
        shortcut.IconLocation = exe_path
        shortcut.Save()
    except Exception as e:
        print(f"Failed to create shortcut: {e}")

# -------------------- GUI --------------------
class Updater(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Mod-Manager Updater")
        self.resize(500, 250)
        self.install_path = None
        self.layout = QVBoxLayout()
        self.setLayout(self.layout)

        self.label = QLabel("Mod-Manager Updater")
        self.label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.layout.addWidget(self.label)

        self.path_btn = QPushButton("Choose Installation Path")
        self.path_btn.clicked.connect(self.choose_path)
        self.layout.addWidget(self.path_btn)

        self.shortcut_checkbox = QCheckBox("Update/Create desktop shortcut")
        self.shortcut_checkbox.setChecked(True)
        self.layout.addWidget(self.shortcut_checkbox)

        self.progress = QProgressBar()
        self.layout.addWidget(self.progress)

        self.update_btn = QPushButton("Update Mod-Manager")
        self.update_btn.clicked.connect(self.start_update)
        self.layout.addWidget(self.update_btn)

        self.finished_label = QLabel("")
        self.finished_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.layout.addWidget(self.finished_label)

        if os.path.exists(INSTALL_JSON):
            with open(INSTALL_JSON, 'r') as f:
                data = json.load(f)
                self.install_path = data.get("path")
                self.finished_label.setText(f"Previous install path detected:\n{self.install_path}")

    def choose_path(self):
        folder = QFileDialog.getExistingDirectory(self, "Select Mod-Manager Folder")
        if folder:
            self.install_path = folder
            self.finished_label.setText(f"Selected path:\n{self.install_path}")

    def start_update(self):
        if not self.install_path:
            QMessageBox.warning(self, "Error", "Please select the installation path first.")
            return
        os.makedirs(self.install_path, exist_ok=True)

        # -------------------- CLOSE MODMANAGER --------------------
        close_modmanager_win()

        # -------------------- DOWNLOAD RESOURCES --------------------
        res_zip_path = os.path.join(self.install_path, RESOURCES_ZIP)
        download_file(f"{GITHUB_RELEASES}/{RESOURCES_ZIP}", res_zip_path, self.progress.setValue)
        unzip_and_merge(res_zip_path, os.path.join(self.install_path, 'resources'))
        os.remove(res_zip_path)

        # -------------------- DOWNLOAD MODMANAGER.EXE --------------------
        modmanager_path = os.path.join(self.install_path, MODMANAGER_EXE)
        old_path = os.path.join(self.install_path, "modmanager_old.exe")
        if os.path.exists(modmanager_path):
            if os.path.exists(old_path):
                os.remove(old_path)
            os.rename(modmanager_path, old_path)

        download_file(f"{GITHUB_RELEASES}/{MODMANAGER_EXE}", modmanager_path, self.progress.setValue)

        # Delete old modmanager_old.exe
        if os.path.exists(old_path):
            os.remove(old_path)

        # -------------------- DOWNLOAD UPDATE_NEW.EXE --------------------
        update_new_path = os.path.join(self.install_path, UPDATE_NEW_EXE)
        if not os.path.exists(update_new_path):
            download_file(f"{GITHUB_RELEASES}/{UPDATE_EXE}", update_new_path)

        # -------------------- SHORTCUT --------------------
        if self.shortcut_checkbox.isChecked():
            create_shortcut(modmanager_path)

        # -------------------- LAUNCH MODMANAGER --------------------
        subprocess.Popen([modmanager_path])
        self.finished_label.setText("✅ Finished updating Mod-Manager!")

if __name__ == "__main__":
    app = QApplication(sys.argv)
    win = Updater()
    win.show()
    sys.exit(app.exec())
