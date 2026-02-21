call PrepareTests.bat
nunit-console-x86.exe "D:\Comos\Team_AI\bin\Comos.IntegrationTest.nunit"  /labels /noshadow /process=Single /domain=None /nothread /apartment=STA /basepath=D:\Comos\Team_AI\bin\ /exclude=Test.Interactive,Interactive.Test,Interactive,UITestBed,UI.Test %*
nunit-console-x86.exe /cleanup
REM reg delete HKEY_CURRENT_USER\Environment /f /v Comos.TestEnvironment.xml
