"""
從 Chrome 瀏覽器抓取 PressPlay cookies
直接讀取 Chrome 的 SQLite cookie 數據庫
"""

import sqlite3
import json
import os
import shutil
import sys
from pathlib import Path

# Fix Unicode encoding on Windows
if sys.platform == 'win32':
    sys.stdout.recoding = 'utf-8'

def extract_chrome_cookies():
    # Chrome cookie 數據庫位置
    username = os.getenv('USERNAME')
    chrome_path = Path(f"C:\\Users\\{username}\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Network\\Cookies")

    if not chrome_path.exists():
        print(f"[❌ 錯誤] Chrome cookie 數據庫找不到: {chrome_path}")
        sys.exit(1)

    # 複製到臨時位置（因為 Chrome 可能鎖住原文件）
    temp_db = Path("C:\\CC AI Agent\\data\\temp_cookies.db")
    temp_db.parent.mkdir(parents=True, exist_ok=True)

    try:
        shutil.copy2(chrome_path, temp_db)
    except PermissionError:
        print("[❌ 錯誤] Chrome 正在使用 cookie 數據庫，無法複製")
        print("[提示] 請關閉所有 Chrome 視窗，再執行此腳本")
        sys.exit(1)

    try:
        # 連接到 cookie 數據庫
        conn = sqlite3.connect(temp_db)
        cursor = conn.cursor()

        # 查詢 pressplay.cc 的 cookies
        cursor.execute("""
            SELECT name, value FROM cookies
            WHERE host_key LIKE '%pressplay.cc%'
        """)

        rows = cursor.fetchall()

        if not rows:
            print("[❌ 錯誤] 找不到 PressPlay 的 cookies！")
            print("[提示] 請確保已登入 PressPlay 帳戶")
            sys.exit(1)

        # 轉換為字典格式
        cookies_dict = {}
        for name, value in rows:
            cookies_dict[name] = value

        # 保存到文件
        output_path = Path("C:\\CC AI Agent\\data\\pressplay_cookies.json")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(cookies_dict, f, indent=2, ensure_ascii=False)

        print(f"\n✅ [成功] 導出 {len(cookies_dict)} 個 cookies")
        print(f"📁 已保存到: {output_path}")

        # 顯示 cookies 摘要
        print("\n📋 Cookies 列表:")
        for name, value in cookies_dict.items():
            display = value[:30] + '...' if len(value) > 30 else value
            print(f"  • {name}: {display}")

        print("\n✨ 下次執行 puhui_daily.js 時會自動使用新的 cookies")

        conn.close()

    finally:
        # 刪除臨時文件
        if temp_db.exists():
            temp_db.unlink()

if __name__ == '__main__':
    extract_chrome_cookies()
