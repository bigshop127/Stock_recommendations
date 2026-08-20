@echo off
chcp 65001 >nul
title Claude Code Update Fix
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude_update.ps1"
