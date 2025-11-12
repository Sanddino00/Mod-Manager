import os
import sys
import shutil
import time
import subprocess

def main():
    base_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
    old_exe = os.path.join(base_dir, "modmanager.exe")
    new_exe = os.path.join(base_dir, "modmanager_new.exe")

    # Wait until the original ModManager closes
    while os.path.exists(old_exe) and is_file_locked(old_exe):
        time.sleep(0.5)

    try:
        if os.path.exists(old_exe):
            os.remove(old_exe)
        if os.path.exists(new_exe):
            shutil.move(new_exe, old_exe)
    except Exception as e:
        print(f"Failed to update exe: {e}")
        input("Press Enter to exit...")
        sys.exit(1)

    # Launch the updated ModManager
    subprocess.Popen([old_exe], cwd=base_dir)
    sys.exit(0)

def is_file_locked(filepath):
    """Return True if file is locked (being used)"""
    if not os.path.exists(filepath):
        return False
    try:
        os.rename(filepath, filepath)
        return False
    except OSError:
        return True

if __name__ == "__main__":
    main()
