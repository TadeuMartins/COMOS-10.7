call PrepareTests.bat
nunit-x86.exe "D:\Comos\Team_AI\bin\Comos.IntegrationTest.nunit"   /exclude=Test.Interactive,Interactive.Test,Interactive,UITestBed,UI.Test %*
nunit-x86.exe /cleanup
REM reg delete HKEY_CURRENT_USER\Environment /f /v Comos.TestEnvironment.xml
