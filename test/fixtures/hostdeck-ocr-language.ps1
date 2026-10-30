param([Parameter(Mandatory)][string]$StatePath,[Parameter(Mandatory)][string]$Title)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System.Drawing;
using System.Windows.Forms;
public sealed class OcrLanguageFixture : Form {
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern System.IntPtr GetForegroundWindow();
    public bool IsForeground { get { return GetForegroundWindow()==Handle; } }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get { var value=base.CreateParams; value.ExStyle |= 0x08000000; return value; }
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        e.Graphics.FillRectangle(Brushes.LightBlue, ClientSize.Width/2, 0, ClientSize.Width/2, ClientSize.Height);
        e.Graphics.TextRenderingHint=System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        using(var font=new Font("Segoe UI",32,FontStyle.Regular,GraphicsUnit.Pixel))
            e.Graphics.DrawString("Belgi\u00eb",font,Brushes.Black,24,48);
    }
}
'@
$form=New-Object OcrLanguageFixture
$form.Text=$Title; $form.ShowInTaskbar=$false; $form.BackColor=[Drawing.Color]::White
$form.StartPosition='Manual'; $form.Location=New-Object Drawing.Point(-20000,-20000)
$form.ClientSize=New-Object Drawing.Size(900,240)
$form.Add_Shown({
    [IO.File]::WriteAllText($StatePath,(@{ready=$true;window_handle=$form.Handle.ToInt64();foreground_is_fixture=$form.IsForeground}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
})
$timer=New-Object Windows.Forms.Timer; $timer.Interval=30000; $timer.Add_Tick({$form.Close()}); $timer.Start()
try {[Windows.Forms.Application]::Run($form)} finally {$timer.Dispose();$form.Dispose()}
