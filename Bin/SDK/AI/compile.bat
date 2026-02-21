@echo off
SET CSC="C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe"
SET BIN=C:\Program Files (x86)\COMOS\Team_AI\Bin
SET SDK=C:\Program Files (x86)\COMOS\Team_AI\Bin\SDK\AI

%CSC% /target:library /out:"%SDK%\Comos.ServiceiPID.Agent.dll" /reference:"%BIN%\Comos.Ai.Functions.dll" /reference:"%BIN%\Comos.Ai.Contracts.dll" /reference:"%BIN%\Interop.Plt.dll" /reference:"%BIN%\Interop.ComosQSGlobalObj.dll" /reference:"%BIN%\Interop.ComosVBInterface.dll" /reference:"%BIN%\Comos.WSP.RoUtilities.dll" /reference:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\Microsoft.CSharp.dll /reference:"C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.ComponentModel.Composition\v4.0_4.0.0.0__b77a5c561934e089\System.ComponentModel.Composition.dll" /reference:"C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.IO.Compression\v4.0_4.0.0.0__b77a5c561934e089\System.IO.Compression.dll" /reference:"C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.IO.Compression.FileSystem\v4.0_4.0.0.0__b77a5c561934e089\System.IO.Compression.FileSystem.dll" "%SDK%\Comos.ServiceiPID.Agent.cs"
echo EXIT_CODE=%ERRORLEVEL%
