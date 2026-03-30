@echo off
cd /d "%~dp0server"
pip install -q -r requirements.txt 2>nul
python main.py
