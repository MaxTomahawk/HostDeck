using System.Buffers.Binary;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.RegularExpressions;

var assembly=Assembly.Load("HostDeck.DesktopWorker");
var type=assembly.GetType("HostDeck.DesktopWorker.EverythingIpc",true)!;
var flags=BindingFlags.NonPublic|BindingFlags.Static;
var failures=new List<string>();
var expression=(string)type.GetMethod("RootExpression",flags)!.Invoke(null,new object[]{@"D:\"})!;
if(!Regex.IsMatch(@"D:\folder\needle.txt",expression)||Regex.IsMatch(@"E:\folder\needle.txt",expression))failures.Add("drive-root scope must match descendants only on its volume");
var nested=(string)type.GetMethod("RootExpression",flags)!.Invoke(null,new object[]{@"D:\safe"})!;
if(!Regex.IsMatch(@"D:\safe\needle.txt",nested)||Regex.IsMatch(@"D:\safely\needle.txt",nested))failures.Add("directory boundary must reject prefix siblings");
using var identity=WindowsIdentity.GetCurrent();
var token=identity.AccessToken.DangerousGetHandle();
var native=assembly.GetType("HostDeck.DesktopWorker.Native",true)!;
var logon=(string)native.GetMethod("LogonId",flags)!.Invoke(null,null)!;
var validate=type.GetMethod("ValidateTargetToken",flags)!;
validate.Invoke(null,new object[]{token,identity.User!.Value,logon});
var rejected=false;
try{validate.Invoke(null,new object[]{token,identity.User.Value,logon=="0000000000000000"?"0000000000000001":"0000000000000000"});}
catch(TargetInvocationException error) when(error.InnerException?.Message=="EVERYTHING_TARGET_DENIED"){rejected=true;}
if(!rejected)failures.Add("same-SID target with differing authentication/logon ID must be refused");

// Synthetic native WTSINFOEXW Level 1 buffer: no Windows lock, UI or input action.
var decodeWts= native.GetMethod("IsUnlockedWtsInfoEx",flags)!;
var wtsInfo=new byte[232]; // complete WTSINFOEXW, with union data at offset 8
BinaryPrimitives.WriteInt32LittleEndian(wtsInfo.AsSpan(0,4),1);   // Level 1
BinaryPrimitives.WriteUInt32LittleEndian(wtsInfo.AsSpan(8,4),7);  // own session
BinaryPrimitives.WriteInt32LittleEndian(wtsInfo.AsSpan(12,4),0); // WTSActive
BinaryPrimitives.WriteInt32LittleEndian(wtsInfo.AsSpan(16,4),1); // unlocked
var pinned=GCHandle.Alloc(wtsInfo,GCHandleType.Pinned);
try {
    var pointer=pinned.AddrOfPinnedObject();
    bool Allows(bool queried=true,uint size=232,uint session=7) =>
        (bool)decodeWts.Invoke(null,new object[]{queried,pointer,size,session})!;
    if(!Allows())failures.Add("active, unlocked, same-session WTSInfoEx Level 1 should pass");
    if(Allows(queried:false))failures.Add("failed WTS query must deny even with unlocked bytes");
    if(Allows(size:231))failures.Add("truncated WTSInfoEx must deny");
    if(Allows(size:0))failures.Add("zero-sized WTSInfoEx must deny");
    if(Allows(session:8)||Allows(session:0))failures.Add("foreign/invalid WTS session must deny");
    if((bool)decodeWts.Invoke(null,new object[]{true,nint.Zero,232u,7u})!)
        failures.Add("null WTS buffer must deny");

    BinaryPrimitives.WriteInt32LittleEndian(wtsInfo.AsSpan(0,4),2);
    if(Allows())failures.Add("unsupported WTSInfoEx level must deny");
    BinaryPrimitives.WriteInt32LittleEndian(wtsInfo.AsSpan(0,4),1);

    BinaryPrimitives.WriteInt32LittleEndian(wtsInfo.AsSpan(12,4),4);
    if(Allows())failures.Add("disconnected WTS session must deny");
    BinaryPrimitives.WriteInt32LittleEndian(wtsInfo.AsSpan(12,4),0);

    foreach(var flag in new[]{0,-1,2}) {
        BinaryPrimitives.WriteInt32LittleEndian(wtsInfo.AsSpan(16,4),flag);
        if(Allows())failures.Add($"locked/unknown/invalid WTS SessionFlags ({flag}) must deny");
    }
} finally { pinned.Free(); }

// Decode only: no keyboard events. Public function-key names are case-insensitive.
var inputType=Assembly.Load("WindowsCommander.Windows").GetType("WindowsCommander.Windows.Services.InputService",true)!;
var keyCode=inputType.GetMethod("ToVirtualKey",flags)!;
for(var key=1;key<=24;key++) {
    foreach(var prefix in new[]{"f","F"}) {
        try {
            var actual=(byte)keyCode.Invoke(null,new object[]{prefix+key})!;
            if(actual!=0x6f+key)failures.Add($"function key {prefix}{key} mapped incorrectly");
        } catch(TargetInvocationException) { failures.Add($"function key {prefix}{key} was refused"); }
    }
}
foreach(var unsupported in new[]{"F0","F25","not-a-key"}) {
    bool denied=false;
    try { keyCode.Invoke(null,new object[]{unsupported}); }
    catch(TargetInvocationException e) when(e.InnerException is ArgumentException) { denied=true; }
    if(!denied)failures.Add("unsupported key must be refused");
}

foreach(var failure in failures)Console.Error.WriteLine(failure);
Console.WriteLine($"Native root/token boundary assertions: {(failures.Count==0?"PASS":"FAIL")}");
return failures.Count==0?0:1;
