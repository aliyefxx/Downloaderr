@echo off
chcp 65001 > nul
title MediaGet Server

echo.
echo ============================================
echo         MediaGet - Media Yukleyici
echo ============================================
echo.

rem Virtual environment yoxlanisi
if not exist "backend\venv" (
    echo [*] Ilk defe ise salinir - asililiqlar qurasdirilir...
    python -m venv backend\venv
    if errorlevel 1 (
        echo [XETA] Python tapilmadi. Zehmet olmasa Python 3.10+ qurasdirin.
        pause
        exit /b 1
    )
    call backend\venv\Scripts\activate.bat
    echo [*] Paketler yuklenir...
    pip install -r backend\requirements.txt --quiet
    echo [OK] Qurasdirma tamamlandi!
    echo.
) else (
    call backend\venv\Scripts\activate.bat
)

echo [*] Server basladilir: http://localhost:8000
echo [*] Sayt brauzerinizde acilir...
echo [*] Dayandirmaq ucun: Ctrl+C
echo --------------------------------------------
echo.

rem Brauzeri avtomatik ac
start http://localhost:8000

rem Serveri venv python ile ise sal
backend\venv\Scripts\python.exe backend\main.py

pause
