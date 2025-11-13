#!/usr/bin/env python3
"""
Updater / Installer for Mod-Manager
Features:
 - Install Mod-Manager into chosen folder (default offered)
 - Download modmanager.exe and resources.zip from latest GitHub release
 - Unzip resources.zip into <install>/resources/
 - Copy this updater into the install folder as update.exe
 - Update mode: replace modmanager.exe and resources, self-update if update.exe present
 - Attempts to stop running modmanager before replacing binary
"""

import sys
import os
import requests
import zipfile
import shutil
import tempfile
import subprocess
import time
import json
from pathlib import Path

from PyQt6.QtWidgets import (
    QApplication, QWidget, QLabel, QVBoxLayout, QHBoxLayout,
    QPushButton, QFileDialog, QLineEdit, QMessageBox, QProgressBar
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal

# ---------------- CONFIG ----------------
GITHUB_API_LATEST = "https://api.github.com/repos/Sanddino00/Mod-Manager/releases/latest"
# Expected asset names (case-insensitive)
EXPECTED_MODMANAGER_NAME = "modmanager.exe"
EXPECTED_RESOURCES_NAME = "resources.zip"
EXPECTED_UPDATE_NAME = "update.exe"  # optional, used for self update
DEFAULT_INSTALL_FOLDER_WIN = os.path.join(os.environ.get("ProgramFiles", "C:\\Program Files"), "Mod-Manager")
CHECK_TIMEOUT = 10  # seconds for network requests

# ---------------- Helper functions ----------------

def normalize_asset_name(name: str) -> str:
    return name.lower().replace(" ", "")

def find_asset_by_name(assets, expected_name):
    exp = expected_name.lower()
    for a in assets:
        name = a.get("name", "").lower()
        if name == exp:
            return a
    # fallback: contains
    for a in assets:
        name = a.get("name", "").lower()
        if exp in name:
            return a
    return None

def download_file(url, dest_path, progress_callback=None):
    """
    Streams download to dest_path. progress_callback(bytes_downloaded, total_bytes) optional.
    """
    with requests.get(url, stream=True, timeout=CHECK_TIMEOUT) as r:
        r.raise_for_status()
        total = int(r.headers.get('content-length', 0))
        downloaded = 0
        with open(dest_path, 'wb') as f:
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if progress_callback:
                        progress_callback(downloaded, total)
    return dest_path

def unzip_to(zip_path, dest_folder, overwrite=True):
    with zipfile.ZipFile(zip_path, 'r') as z:
        # If overwrite: extract all (replace)
        if overwrite:
            tempdir = tempfile.mkdtemp()
            try:
                z.extractall(tempdir)
                # copy contents to dest_folder recursively
                for root, dirs, files in os.walk(tempdir):
                    rel = os.path.relpath(root, tempdir)
                    target_root = os.path.join(dest_folder, rel) if rel != '.' else dest_folder
                    os.makedirs(target_root, exist_ok=True)
                    for f in files:
                        src = os.path.join(root, f)
                        dst = os.path.join(target_root, f)
                        shutil.copy2(src, dst)
            finally:
                shutil.rmtree(tempdir, ignore_errors=True)
        else:
            z.extractall(dest_folder)

def ensure_dir(p):
    os.makedirs(p, exist_ok=True)
    return p

def is_modmanager_running():
    # Try platform-specific checks
    name = "modmanager.exe" if os.name == "nt" else "modmanager"
    if os.name == "nt":
        try:
            out = subprocess.check_output(["tasklist", "/FI", f"IMAGENAME eq {name}"], text=True)
            return name.lower() in out.lower()
        except Exception:
            return False
    else:
        try:
            out = subprocess.check_output(["pgrep", "-f", name], text=True)
            return bool(out.strip())
        except Exception:
            return False

def kill_modmanager():
    name = "modmanager.exe" if os.name == "nt" else "modmanager"
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/F", "/IM", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except Exception:
            return False
    else:
        try:
            subprocess.run(["pkill", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except Exception:
            return False

def atomic_replace(src, dst):
    # Replace dst with src atomically (move)
    try:
        if os.path.exists(dst):
            os.remove(dst)
        shutil.move(src, dst)
        return True
    except Exception:
        try:
            shutil.copy2(src, dst)
            os.remove(src)
            return True
        except Exception:
            return False

def run_and_detach(path, args=[]):
    if os.name == "nt":
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        subprocess.Popen([path] + args, startupinfo=si, close_fds=True)
    else:
        subprocess.Popen([path] + args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)

# ---------------- GitHub release helpers ----------------

def get_latest_release_info():
    """
    Returns dict of latest release info from GitHub API or raises on error.
    """
    r = requests.get(GITHUB_API_LATEST, timeout=CHECK_TIMEOUT, headers={"Accept":"application/vnd.github.v3+json"})
    r.raise_for_status()
    return r.json()

# ---------------- Worker thread for network ops ----------------

class WorkerThread(QThread):
    progress = pyqtSignal(str)
    finished = pyqtSignal(bool, str)  # success, message

    def __init__(self, task_fn, *args, **kwargs):
        super().__init__()
        self.task_fn = task_fn
        self.args = args
        self.kwargs = kwargs

    def run(self):
        try:
            self.progress.emit("Starting...")
            msg = self.task_fn(self.progress, *self.args, **self.kwargs)
            self.finished.emit(True, msg or "Done")
        except Exception as e:
            self.finished.emit(False, f"Error: {e}")

# ---------------- GUI ----------------

class UpdaterGUI(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Mod-Manager Installer / Updater")
        self.resize(640, 320)
        self.install_path = DEFAULT_INSTALL_FOLDER_WIN if os.name == "nt" else os.path.join(str(Path.home()), "Mod-Manager")
        self.latest_release = None
        self.assets = []
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        self.setLayout(layout)

        # Status label
        self.status_label = QLabel("Ready")
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignLeft)
        layout.addWidget(self.status_label)

        # Install path
        h = QHBoxLayout()
        h.addWidget(QLabel("Install Folder:"))
        self.path_edit = QLineEdit(self.install_path)
        h.addWidget(self.path_edit)
        btn = QPushButton("Browse")
        btn.clicked.connect(self.browse_install)
        h.addWidget(btn)
        layout.addLayout(h)

        # Buttons row
        btn_row = QHBoxLayout()
        self.check_btn = QPushButton("Check for updates")
        self.check_btn.clicked.connect(self.on_check_updates)
        btn_row.addWidget(self.check_btn)

        self.install_btn = QPushButton("Install (or Reinstall)")
        self.install_btn.clicked.connect(self.on_install)
        btn_row.addWidget(self.install_btn)

        self.update_exe_btn = QPushButton("Update EXE")
        self.update_exe_btn.clicked.connect(self.on_update_exe)
        btn_row.addWidget(self.update_exe_btn)

        self.update_res_btn = QPushButton("Update Resources")
        self.update_res_btn.clicked.connect(self.on_update_resources)
        btn_row.addWidget(self.update_res_btn)

        layout.addLayout(btn_row)

        # Progress / info area
        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 0)  # indeterminate until progress emitted
        self.progress_bar.setVisible(False)
        layout.addWidget(self.progress_bar)

        self.log_label = QLabel("")
        self.log_label.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self.log_label.setWordWrap(True)
        layout.addWidget(self.log_label)

        # Short instructions
        layout.addWidget(QLabel("Notes: This updater expects release assets named exactly 'modmanager.exe' and 'resources.zip'."))

    def browse_install(self):
        folder = QFileDialog.getExistingDirectory(self, "Choose Install Folder", self.install_path)
        if folder:
            self.install_path = folder
            self.path_edit.setText(folder)

    def set_status(self, s):
        self.status_label.setText(s)
        self.log_label.setText(s)

    def on_check_updates(self):
        self.set_status("Checking latest release...")
        self.start_worker(self.task_check_latest)

    def on_install(self):
        self.install_path = self.path_edit.text().strip() or self.install_path
        self.set_status(f"Install to: {self.install_path}")
        self.start_worker(self.task_install)

    def on_update_exe(self):
        self.install_path = self.path_edit.text().strip() or self.install_path
        self.start_worker(self.task_update_exe)

    def on_update_resources(self):
        self.install_path = self.path_edit.text().strip() or self.install_path
        self.start_worker(self.task_update_resources)

    def start_worker(self, fn):
        self.progress_bar.setVisible(True)
        self.progress_bar.setRange(0, 0)
        self.thread = WorkerThread(fn)
        self.thread.progress.connect(self.on_progress)
        self.thread.finished.connect(self.on_finished)
        self.thread.start()

    def on_progress(self, msg):
        self.log_label.setText(msg)
        # If msg includes "progress: x/y" we could update bar, but keep indeterminate for simplicity

    def on_finished(self, success, message):
        self.progress_bar.setVisible(False)
        self.progress_bar.setRange(0, 100)
        self.set_status(message)
        if not success:
            QMessageBox.critical(self, "Error", message)
        else:
            QMessageBox.information(self, "Done", message)

    # -------------------- Tasks --------------------

    def task_check_latest(self, progress):
        progress.emit("Querying GitHub API for latest release...")
        info = get_latest_release_info()
        self.latest_release = info
        assets = info.get("assets", [])
        self.assets = assets
        names = ", ".join([a.get("name", "") for a in assets])
        progress.emit(f"Latest release: {info.get('tag_name', '')}. Assets: {names}")
        return f"Latest: {info.get('tag_name', '')}"

    def _download_asset_by_expected(self, expected_name, dest_file, progress):
        # ensure latest_release loaded
        if not self.latest_release:
            progress.emit("Fetching latest release info...")
            self.latest_release = get_latest_release_info()
            self.assets = self.latest_release.get("assets", [])
        asset = find_asset_by_name(self.assets, expected_name)
        if not asset:
            raise FileNotFoundError(f"Asset '{expected_name}' not found in release assets.")
        url = asset.get("browser_download_url")
        progress.emit(f"Downloading {asset.get('name')} ...")
        # Use streaming download and update progress
        def cb(downloaded, total):
            if total:
                pct = int(downloaded * 100 / total)
                self.progress_bar.setRange(0,100)
                self.progress_bar.setValue(pct)
        download_file(url, dest_file, progress_callback=cb)
        return dest_file

    def task_install(self, progress):
        # Steps:
        # 1) get latest release info
        progress.emit("Fetching latest release info...")
        info = get_latest_release_info()
        self.latest_release = info
        self.assets = info.get("assets", [])
        tag = info.get("tag_name", "unknown")
        progress.emit(f"Latest release: {tag}")

        tempdir = tempfile.mkdtemp()
        try:
            # 2) download modmanager.exe
            mod_dest = os.path.join(tempdir, EXPECTED_MODMANAGER_NAME)
            self._download_asset_by_expected(EXPECTED_MODMANAGER_NAME, mod_dest, progress)

            # 3) download resources.zip
            res_dest = os.path.join(tempdir, EXPECTED_RESOURCES_NAME)
            self._download_asset_by_expected(EXPECTED_RESOURCES_NAME, res_dest, progress)

            # 4) ensure install folder and resources folder
            install_root = os.path.abspath(self.install_path)
            if not os.path.exists(install_root):
                os.makedirs(install_root, exist_ok=True)
            resources_folder = os.path.join(install_root, "resources")
            os.makedirs(resources_folder, exist_ok=True)

            # 5) stop running modmanager
            progress.emit("Attempting to stop running Mod-Manager (if any)...")
            if is_modmanager_running():
                progress.emit("Mod-Manager is running; attempting to terminate...")
                kill_modmanager()
                # wait up to 6 seconds
                for i in range(12):
                    if not is_modmanager_running():
                        break
                    time.sleep(0.5)

            # 6) move modmanager.exe into place
            dest_mod = os.path.join(install_root, EXPECTED_MODMANAGER_NAME)
            progress.emit(f"Installing {EXPECTED_MODMANAGER_NAME} ...")
            if os.path.exists(dest_mod):
                try:
                    os.remove(dest_mod)
                except Exception:
                    pass
            shutil.copy2(mod_dest, dest_mod)

            # 7) unzip resources.zip into resources folder
            progress.emit("Unpacking resources...")
            unzip_to(res_dest, resources_folder, overwrite=True)

            # 8) copy this updater to install folder as update.exe
            progress.emit("Copying updater into install folder...")
            exe_src = sys.executable if getattr(sys, "frozen", False) else __file__
            # if running as script, copy the script; recommend building exe for production
            updater_dst = os.path.join(install_root, EXPECTED_UPDATE_NAME)
            try:
                shutil.copy2(exe_src, updater_dst)
            except Exception:
                # try to copy the current script's path
                try:
                    shutil.copy2(__file__, updater_dst)
                except Exception as e:
                    progress.emit(f"Warning copying updater: {e}")

            # 9) create shortcut? (optional - not implemented)
            progress.emit(f"Installed to {install_root}.")
            # Launch installed modmanager
            progress.emit("Launching Mod-Manager...")
            run_and_detach(dest_mod, [])
            return f"Installed Mod-Manager {tag} to {install_root}"
        finally:
            shutil.rmtree(tempdir, ignore_errors=True)

    def task_update_exe(self, progress):
        # Download new modmanager.exe and replace existing; restart modmanager
        progress.emit("Preparing to update modmanager.exe...")
        info = get_latest_release_info()
        self.latest_release = info
        self.assets = info.get("assets", [])
        tempdir = tempfile.mkdtemp()
        try:
            mod_dest = os.path.join(tempdir, EXPECTED_MODMANAGER_NAME)
            self._download_asset_by_expected(EXPECTED_MODMANAGER_NAME, mod_dest, progress)

            install_root = os.path.abspath(self.install_path)
            dest_mod = os.path.join(install_root, EXPECTED_MODMANAGER_NAME)
            if not os.path.exists(dest_mod):
                raise FileNotFoundError(f"No existing modmanager at {dest_mod} — consider using Install first.")

            # Kill running modmanager
            if is_modmanager_running():
                progress.emit("Stopping running Mod-Manager...")
                kill_modmanager()
                for i in range(12):
                    if not is_modmanager_running():
                        break
                    time.sleep(0.5)

            progress.emit("Replacing modmanager.exe ...")
            # Atomic replace
            tmp_target = dest_mod + ".new"
            try:
                if os.path.exists(tmp_target):
                    os.remove(tmp_target)
            except Exception:
                pass
            shutil.copy2(mod_dest, tmp_target)
            # Move into place
            if os.path.exists(dest_mod):
                try:
                    os.remove(dest_mod)
                except Exception:
                    pass
            shutil.move(tmp_target, dest_mod)
            # optionally update updater too if present in release
            update_asset = find_asset_by_name(self.assets, EXPECTED_UPDATE_NAME)
            if update_asset:
                progress.emit("Downloading new updater (update.exe) for self-update...")
                upd_tmp = os.path.join(tempdir, EXPECTED_UPDATE_NAME)
                self._download_asset_by_expected(EXPECTED_UPDATE_NAME, upd_tmp, progress)
                # replace update.exe in install folder via helper (because this updater may be the same file)
                installed_updater = os.path.join(install_root, EXPECTED_UPDATE_NAME)
                if os.path.exists(installed_updater):
                    progress.emit("Replacing installed updater...")
                    # write new file to installed_updater.new then schedule replacement
                    tmp_up = installed_updater + ".new"
                    shutil.copy2(upd_tmp, tmp_up)
                    # Use batch/shell to move after exit
                    self._schedule_replace_and_exit(tmp_up, installed_updater)
                    # This will exit this process to let replacement happen
                    return "Updater replacement scheduled; exiting to finish update."
                else:
                    # just copy over
                    shutil.copy2(upd_tmp, installed_updater)
            progress.emit("Starting updated Mod-Manager...")
            run_and_detach(dest_mod, [])
            return "Mod-Manager executable updated and launched."
        finally:
            shutil.rmtree(tempdir, ignore_errors=True)

    def task_update_resources(self, progress):
        progress.emit("Preparing to update resources...")
        info = get_latest_release_info()
        self.latest_release = info
        self.assets = info.get("assets", [])
        tempdir = tempfile.mkdtemp()
        try:
            res_dest = os.path.join(tempdir, EXPECTED_RESOURCES_NAME)
            self._download_asset_by_expected(EXPECTED_RESOURCES_NAME, res_dest, progress)

            install_root = os.path.abspath(self.install_path)
            resources_folder = os.path.join(install_root, "resources")
            if not os.path.exists(resources_folder):
                os.makedirs(resources_folder, exist_ok=True)

            progress.emit("Unpacking resources...")
            unzip_to(res_dest, resources_folder, overwrite=True)

            progress.emit("Resources updated.")
            # optionally launch modmanager if not running
            return "Resources updated."
        finally:
            shutil.rmtree(tempdir, ignore_errors=True)

    def _schedule_replace_and_exit(self, new_file_path, target_path):
        """
        Schedule replacement of target_path by new_file_path after this process exits.
        For Windows: create a small batch that waits for process to exit then moves file.
        For POSIX: create a shell script to do the same.
        Then launch it detached and exit current process.
        """
        progress_text = f"Scheduling replacement of {target_path}"
        # Windows batch approach
        if os.name == "nt":
            bat = tempfile.mktemp(suffix=".bat")
            # The batch will:
            # - wait until target is unlockable (try to delete it)
            # - move new_file_path to target_path
            # - optionally remove itself
            script = f"""@echo off
SETLOCAL ENABLEDELAYEDEXPANSION
REM wait loop
ping 127.0.0.1 -n 2 >nul
:loop
del "{target_path}" >nul 2>&1
if exist "{target_path}" (
  timeout /t 1 /nobreak >nul
  goto loop
)
move /Y "{new_file_path}" "{target_path}" >nul 2>&1
del "%~f0" >nul 2>&1
"""
            with open(bat, "w", encoding="utf-8") as f:
                f.write(script)
            # launch batch detached
            CREATE_NO_WINDOW = 0x08000000
            DETACHED_PROCESS = 0x00000008
            try:
                subprocess.Popen(["cmd.exe", "/C", bat], creationflags=DETACHED_PROCESS)
            except Exception:
                subprocess.Popen(["cmd.exe", "/C", bat])
            # exit current process to allow batch to replace
            QApplication.instance().quit()
            sys.exit(0)
        else:
            sh = tempfile.mktemp(suffix=".sh")
            script = f"""#!/bin/sh
sleep 1
while [ -e "{target_path}" ]; do
  rm -f "{target_path}" 2>/dev/null || true
  sleep 1
done
mv "{new_file_path}" "{target_path}" || true
rm -- "$0"
"""
            with open(sh, "w", encoding="utf-8") as f:
                f.write(script)
            os.chmod(sh, 0o755)
            subprocess.Popen(["/bin/sh", sh], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            QApplication.instance().quit()
            sys.exit(0)

# ---------------- Main ----------------

def main():
    app = QApplication(sys.argv)
    gui = UpdaterGUI()
    gui.show()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()
