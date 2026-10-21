param([Parameter(Mandatory)][string]$StatePath,[Parameter(Mandatory)][string]$Title)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form=New-Object System.Windows.Forms.Form
$form.Text=$Title;$form.TopMost=$true;$form.StartPosition='Manual';$form.Location=New-Object Drawing.Point(50,50);$form.Size=New-Object Drawing.Size(500,300)
$text=New-Object System.Windows.Forms.TextBox
$text.Name='HostDeckFixtureText';$text.Location=New-Object Drawing.Point(20,20);$text.Width=300
$button=New-Object System.Windows.Forms.Button
$button.Name='HostDeckFixtureButton';$button.Text='Fixture click';$button.Location=New-Object Drawing.Point(20,90);$button.Size=New-Object Drawing.Size(120,35)
$script:clicks=0
function Save-State{[IO.File]::WriteAllText($StatePath,(@{text=$text.Text;clicks=$script:clicks}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))}
$text.Add_TextChanged({Save-State});$button.Add_Click({$script:clicks++;Save-State})
$form.Controls.Add($text);$form.Controls.Add($button)
$form.Add_Shown({$form.Activate();$text.Focus()|Out-Null;Save-State})
$timer=New-Object System.Windows.Forms.Timer;$timer.Interval=90000;$timer.Add_Tick({$form.Close()});$timer.Start()
try{[Windows.Forms.Application]::Run($form)}finally{$timer.Dispose();$form.Dispose()}
