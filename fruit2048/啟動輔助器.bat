@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在檢查相依套件...
python -c "import numpy, PIL, mss" 2>nul
if errorlevel 1 (
    echo 缺少套件，開始安裝...
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo.
        echo 安裝失敗。請確認已安裝 Python 3.9 以上並勾選 "Add Python to PATH"。
        pause
        exit /b 1
    )
)

echo 啟動中...
python app.py
if errorlevel 1 (
    echo.
    echo 程式異常結束，上面是錯誤訊息。
    pause
)
