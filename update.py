import os
import sys
import json
import shutil
import zipfile
import subprocess
import re
from tkinter import Tk, Label, Button, StringVar, IntVar, Checkbutton, Entry, filedialog, messagebox
from tkinter.ttk import Progressbar
import requests

# -------------------- CONFIG --------------------
GITHUB_RELEASES_URL = "https://github.com/Sanddino00/Mod-Manager/releases/latest/download"
MODMANAGER_EXE_NAME = "modmanager.exe"
UPDATE_EXE_NAME = "update.exe"
RESOURCES_ZIP_NAME = "resources.zip"

SETTINGS_FILE = "install_path.json"
resources_folder_name = "resources"


def parse_mode_args(argv):
    """Return (is_updater_mode, install_dir_override)."""
    is_updater = False
    install_dir = None
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--updater":
            is_updater = True
        elif arg == "--install-dir" and i + 1 < len(argv):
            install_dir = argv[i + 1]
            i += 1
        i += 1
    return is_updater, install_dir

# -------------------- GUI --------------------
class InstallerUpdater:
    def __init__(self, root, updater_mode=False, install_dir_override=None):
        self.root = root
        self.updater_mode = bool(updater_mode)
        self.install_dir_override = install_dir_override

        root.title("Mod-Manager Updater" if self.updater_mode else "Mod-Manager Installer / Updater")
        root.geometry("500x300")

        # Path
        self.path_var = StringVar()
        self.load_install_path()
        if self.install_dir_override:
            self.path_var.set(self.install_dir_override)
        elif self.updater_mode:
            # In updater mode default to local executable folder.
            self.path_var.set(os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__)))
        Label(root, text="Installation Path:").pack(pady=5)
        self.path_entry = Entry(root, textvariable=self.path_var, width=60)
        self.path_entry.pack(pady=5)
        self.browse_btn = Button(root, text="Browse", command=self.browse_path)
        self.browse_btn.pack()

        # Shortcut option
        self.create_shortcut_var = IntVar()
        self.shortcut_box = Checkbutton(root, text="Create Desktop Shortcut", variable=self.create_shortcut_var)
        self.shortcut_box.pack(pady=5)

        # Progress bar
        self.progress = IntVar()
        self.progress_bar = Progressbar(root, length=400, variable=self.progress, maximum=100)
        self.progress_bar.pack(pady=10)

        # Status label
        self.status_var = StringVar()
        self.status_var.set("Idle")
        Label(root, textvariable=self.status_var).pack(pady=5)

        # Buttons
        self.run_btn = Button(root, text="Install / Update", command=self.run)
        self.run_btn.pack(pady=10)
        self.exit_btn = Button(root, text="Exit", command=root.quit)
        self.exit_btn.pack()

        if self.updater_mode:
            self.path_entry.configure(state="disabled")
            self.browse_btn.pack_forget()
            self.shortcut_box.pack_forget()
            self.run_btn.pack_forget()
            self.status_var.set("Updater mode: updating automatically...")
            self.root.after(150, lambda: self.run(auto_mode=True))

    # -------------------- PATH --------------------
    def browse_path(self):
        folder = filedialog.askdirectory()
        if folder:
            self.path_var.set(folder)

    def load_install_path(self):
        if os.path.exists(SETTINGS_FILE):
            try:
                with open(SETTINGS_FILE, "r") as f:
                    data = json.load(f)
                    self.path_var.set(data.get("install_path", ""))
            except:
                self.path_var.set("")

    def save_install_path(self):
        data = {"install_path": self.path_var.get()}
        with open(SETTINGS_FILE, "w") as f:
            json.dump(data, f, indent=2)

    # -------------------- DOWNLOAD --------------------
    def download_file(self, url, dest):
        with requests.get(url, stream=True) as r:
            r.raise_for_status()
            total = int(r.headers.get('content-length', 0))
            downloaded = 0
            with open(dest, 'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        percent = int(downloaded / total * 100) if total else 0
                        self.progress.set(percent)
                        self.root.update_idletasks()

    # -------------------- UTILS --------------------
    def unzip_and_merge(self, zip_path, dest_folder):
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            for member in zip_ref.namelist():
                # Remove top-level "resources/" folder if present
                parts = member.split(os.sep)
                if parts[0].lower() == resources_folder_name.lower():
                    parts = parts[1:]
                target_path = os.path.join(dest_folder, *parts)
                if member.endswith('/'):
                    os.makedirs(target_path, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(target_path), exist_ok=True)
                    with zip_ref.open(member) as source, open(target_path, 'wb') as target:
                        shutil.copyfileobj(source, target)

    def create_shortcut(self, exe_path):
        try:
            import pythoncom
            from win32com.shell import shell, shellcon
        except ImportError:
            messagebox.showerror("Error", "pywin32 is required for shortcut creation.")
            return
        desktop = shell.SHGetFolderPath(0, shellcon.CSIDL_DESKTOP, None, 0)
        shortcut_path = os.path.join(desktop, "Mod-Manager.lnk")
        shell_link = pythoncom.CoCreateInstance(
            shell.CLSID_ShellLink, None,
            pythoncom.CLSCTX_INPROC_SERVER, shell.IID_IShellLink
        )
        shell_link.SetPath(exe_path)
        shell_link.SetWorkingDirectory(os.path.dirname(exe_path))
        persist_file = shell_link.QueryInterface(pythoncom.IID_IPersistFile)
        persist_file.Save(shortcut_path, 0)

    def close_modmanager(self, install_dir):
        exe_path = os.path.join(install_dir, MODMANAGER_EXE_NAME)
        subprocess.run(["taskkill", "/f", "/im", MODMANAGER_EXE_NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def cleanup_old_files(self, install_dir, resources_path):
        """Remove stale files before unpacking new resources."""
        try:
            for p in (
                os.path.join(install_dir, "version.txt"),
                os.path.join(resources_path, "version.txt"),
            ):
                if os.path.exists(p):
                    os.remove(p)
        except Exception:
            pass

        try:
            if os.path.isdir(resources_path):
                for name in os.listdir(resources_path):
                    if re.match(r"^v?\d+(\.\d+)*\.txt$", name, re.IGNORECASE):
                        fp = os.path.join(resources_path, name)
                        if os.path.isfile(fp):
                            os.remove(fp)
        except Exception:
            pass

        # Replace old icons completely to prevent stale icon leftovers.
        try:
            icons_path = os.path.join(resources_path, "icons")
            if os.path.isdir(icons_path):
                shutil.rmtree(icons_path)
        except Exception:
            pass

    def schedule_updater_swap(self, install_dir, update_new_path, update_path):
        """Swap update_new.exe -> update.exe after this updater process exits."""
        if not os.path.exists(update_new_path):
            return
        bat_path = os.path.join(install_dir, "swap_updater.bat")
        try:
            with open(bat_path, "w", encoding="utf-8") as f:
                f.write("@echo off\n")
                f.write("setlocal\n")
                f.write("ping 127.0.0.1 -n 3 > nul\n")
                f.write(":retry\n")
                f.write(f"move /Y \"{update_new_path}\" \"{update_path}\" > nul 2>&1\n")
                f.write("if errorlevel 1 (\n")
                f.write("  ping 127.0.0.1 -n 2 > nul\n")
                f.write("  goto retry\n")
                f.write(")\n")
                f.write("del /F /Q \"%~f0\"\n")
            subprocess.Popen(["cmd", "/c", bat_path], cwd=install_dir)
        except Exception as e:
            self.status_var.set(f"Warning: updater swap not scheduled ({e})")
            self.root.update_idletasks()

    # -------------------- MAIN --------------------
    def run(self, auto_mode=False):
        install_dir = self.path_var.get()
        if not install_dir:
            messagebox.showerror("Error", "Please select an installation path.")
            return
        self.save_install_path()
        os.makedirs(install_dir, exist_ok=True)
        modmanager_path = os.path.join(install_dir, MODMANAGER_EXE_NAME)
        update_path = os.path.join(install_dir, UPDATE_EXE_NAME)
        resources_path = os.path.join(install_dir, resources_folder_name)

        self.status_var.set("Updating Mod-Manager...")
        self.root.update_idletasks()

        # -------------------- CLOSE MODMANAGER --------------------
        self.close_modmanager(install_dir)

        # -------------------- DOWNLOAD UPDATE.EXE --------------------
        update_new_path = os.path.join(install_dir, "update_new.exe")
        if not os.path.exists(update_new_path):
            self.status_var.set("Downloading updater...")
            self.root.update_idletasks()
            self.download_file(f"{GITHUB_RELEASES_URL}/{UPDATE_EXE_NAME}", update_new_path)

        # -------------------- DOWNLOAD MODMANAGER --------------------
        self.status_var.set("Downloading Mod-Manager...")
        self.root.update_idletasks()
        if os.path.exists(modmanager_path):
            old_path = modmanager_path.replace(".exe", "_old.exe")
            os.rename(modmanager_path, old_path)
        self.download_file(f"{GITHUB_RELEASES_URL}/{MODMANAGER_EXE_NAME}", modmanager_path)
        if os.path.exists(modmanager_path.replace(".exe", "_old.exe")):
            os.remove(modmanager_path.replace(".exe", "_old.exe"))

        # -------------------- DOWNLOAD RESOURCES --------------------
        self.status_var.set("Downloading resources...")
        self.root.update_idletasks()
        tmp_zip = os.path.join(install_dir, RESOURCES_ZIP_NAME)
        self.download_file(f"{GITHUB_RELEASES_URL}/{RESOURCES_ZIP_NAME}", tmp_zip)
        os.makedirs(resources_path, exist_ok=True)
        self.cleanup_old_files(install_dir, resources_path)
        self.unzip_and_merge(tmp_zip, resources_path)
        os.remove(tmp_zip)

        # -------------------- CREATE SHORTCUT --------------------
        if (not auto_mode) and self.create_shortcut_var.get():
            self.create_shortcut(modmanager_path)

        self.status_var.set("Finished updating!")
        self.progress.set(100)
        self.root.update_idletasks()

        # Schedule updater self-replacement after this process exits.
        self.schedule_updater_swap(install_dir, update_new_path, update_path)

        # -------------------- LAUNCH MODMANAGER --------------------
        subprocess.Popen(modmanager_path)
        self.root.after(1200 if auto_mode else 2000, self.root.destroy)


# -------------------- RUN --------------------
if __name__ == "__main__":
    updater_mode, install_dir_override = parse_mode_args(sys.argv[1:])
    root = Tk()
    app = InstallerUpdater(root, updater_mode=updater_mode, install_dir_override=install_dir_override)
    root.mainloop()
