-- SHIVA launcher: double-click to start (opens the Sanctum in standby),
-- double-click again to stop. Clap twice + "wake up" raises the other windows.
on run
	set odinRoot to "/Users/Yaduchiroth_1/Claude/Projects/SHIVA"
	set chromeBin to "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	try
		do shell script "pgrep -if '[p]ython -m shiva' >/dev/null 2>&1"
		do shell script "pkill -if '[p]ython -m shiva'"
		display notification "SHIVA stands down." with title "SHIVA"
	on error
		do shell script "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; cd " & quoted form of odinRoot & " && nohup ./.venv/bin/python -m shiva >/tmp/shiva.log 2>&1 &"
		display notification "SHIVA stands by — clap twice and say wake up." with title "SHIVA"
	end try
end run
