@echo off
echo === SecureChat ===
echo.
echo Запуск сервера...
start "SecureChat Server" cmd /k "cd /d %~dp0server && node index.js"
timeout /t 2 /nobreak > nul
echo Запуск клиента...
start "SecureChat Client" cmd /k "cd /d %~dp0client && npm run dev"
timeout /t 3 /nobreak > nul
echo.
echo Открытие браузера...
start http://localhost:5173
echo.
echo Сервер: http://localhost:3001
echo Клиент: http://localhost:5173
echo.
pause
