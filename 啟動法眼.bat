@echo off
chcp 65001 >nul
title LegalEye
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve.ps1"
