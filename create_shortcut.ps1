$path = "C:\Users\bigsh\OneDrive\桌面\我是AI大師\巫師3"
New-Item -Path $path -ItemType Directory -Force
$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$path\Gemini-巫師3專案.lnk")
$Shortcut.TargetPath = "cmd.exe"
$Shortcut.Arguments = "/k gemini"
$Shortcut.WorkingDirectory = "D:\TheWitcher3"
$Shortcut.Save()
Write-Output "Shortcut created successfully"