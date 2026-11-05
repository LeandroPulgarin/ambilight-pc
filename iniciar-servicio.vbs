' Arranca servicio.js sin ventana. Se copia un acceso a esta ruta en la carpeta Inicio de Windows.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = dir
shell.Run "node """ & dir & "\servicio.js""", 0, False
