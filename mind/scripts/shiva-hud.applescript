-- SHIVA HUD: reopens the Sanctum window (Council/Connectors reachable via its nav).
on run
	set chromeBin to "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	try
		do shell script "test -x " & quoted form of chromeBin
		do shell script "nohup " & quoted form of chromeBin & " --app=http://localhost:8377/sanctum.html >/dev/null 2>&1 &"
	on error
		do shell script "open 'http://localhost:8377/sanctum.html'"
	end try
end run
