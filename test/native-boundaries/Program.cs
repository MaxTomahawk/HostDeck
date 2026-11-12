using System.Buffers.Binary;
using System.Collections.Specialized;
using System.Drawing;
using System.Windows.Forms;
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
// INPUT074: END failed in the installed remote tool before Ctrl+A could run.
// Decode only: this regression never injects keyboard input.
foreach(var name in new[]{"end","END","End"}) {
    try {
        if((byte)keyCode.Invoke(null,new object[]{name})! != 0x23)
            failures.Add($"navigation key {name} mapped incorrectly");
    } catch(TargetInvocationException) { failures.Add($"navigation key {name} was refused"); }
}
foreach(var unsupported in new[]{"F0","F25","not-a-key"}) {
    bool denied=false;
    try { keyCode.Invoke(null,new object[]{unsupported}); }
    catch(TargetInvocationException e) when(e.InnerException is ArgumentException) { denied=true; }
    if(!denied)failures.Add("unsupported key must be refused");
}


// INPUT clipboard safety: synthetic IDataObject and callbacks only.
// Absolutely no real Clipboard.Get/Set, keyboard events or user content.
var snapshotMethod=inputType.GetMethod("SnapshotClipboardData",flags)!;
var pasteMethod=inputType.GetMethod("PasteWithPreservation",flags)!;
var sequenceMethod=inputType.GetMethod("SameClipboardSequence",flags)!;
void Check(bool condition,string message) { if(!condition) failures.Add(message); }
DataObject Snapshot(IDataObject? value) =>
    (DataObject)snapshotMethod.Invoke(null,new object?[]{value})!;
bool SnapshotDenied(IDataObject? value) {
    try { Snapshot(value); return false; }
    catch(TargetInvocationException error) {
        return error.InnerException is InvalidOperationException exception &&
            exception.Message=="Clipboard formats could not all be preserved." &&
            exception.InnerException is null;
    }
}
var synthetic=new SyntheticClipboardSource();
var binary=new byte[]{5,6,7};
using var stream=new MemoryStream(new byte[]{8,9,10});
stream.Position=2;
using var image=new Bitmap(2,2);
var files=new string[]{@"X:\owned-fixture-a.txt",@"X:\owned-fixture-b.txt"};
var fileCollection=new StringCollection();
fileCollection.AddRange(files);
synthetic.Formats=new[]{DataFormats.UnicodeText,DataFormats.Html,DataFormats.Bitmap,
    DataFormats.FileDrop,"SyntheticBinary","SyntheticStream","SyntheticFileList"};
synthetic.Values[DataFormats.UnicodeText]="synthetic text";
synthetic.Values[DataFormats.Html]="<b>synthetic html</b>";
synthetic.Values[DataFormats.Bitmap]=image;
synthetic.Values[DataFormats.FileDrop]=files;
synthetic.Values["SyntheticBinary"]=binary;
synthetic.Values["SyntheticStream"]=stream;
synthetic.Values["SyntheticFileList"]=fileCollection;
var copy=Snapshot(synthetic);
Check(copy.GetFormats(false).Length==synthetic.Formats.Length,"all synthetic formats must be copied");
Check((string)copy.GetData(DataFormats.Html,false)!=="<b>synthetic html</b>",
    "HTML data must survive complete snapshot");
Check(!ReferenceEquals(image,copy.GetData(DataFormats.Bitmap,false)),"bitmap must clone");
Check(!ReferenceEquals(files,copy.GetData(DataFormats.FileDrop,false)),"file-list array must clone");
Check(!ReferenceEquals(binary,copy.GetData("SyntheticBinary",false)),"binary bytes must clone");
binary[0]=99;
Check(((byte[])copy.GetData("SyntheticBinary",false)!)[0]==5,"snapshot must own binary bytes");
Check(stream.Position==2,"cloning a stream must restore source position");
Check(!ReferenceEquals(stream,copy.GetData("SyntheticStream",false)) &&
    ((MemoryStream)copy.GetData("SyntheticStream",false)!).ToArray().SequenceEqual(new byte[]{8,9,10}),
    "stream must be an independent full copy");
Check(!ReferenceEquals(fileCollection,copy.GetData("SyntheticFileList",false)) &&
    ((StringCollection)copy.GetData("SyntheticFileList",false)!).Count==2,
    "StringCollection must be cloned");
Check(SnapshotDenied(null),"unknown clipboard must be refused");

var partial=new SyntheticClipboardSource { Formats=new[]{"Good","Missing"} };
partial.Values["Good"]="good";
Check(SnapshotDenied(partial),"partial clipboard snapshot must fail");
partial.ThrowOnData="Missing";
Check(SnapshotDenied(partial),"throwing format reader must fail without leaking error text");
partial.ThrowOnData=null;
partial.NullFormats=true;
Check(SnapshotDenied(partial),"null format list must fail");
partial.NullFormats=false;
partial.ThrowOnFormats=true;
Check(SnapshotDenied(partial),"throwing format list must fail");
partial.ThrowOnFormats=false;
partial.Values["Missing"]=new object();
Check(SnapshotDenied(partial),"uncloneable object must refuse");
partial.Values["Missing"]=new SyntheticUnseekableStream();
Check(SnapshotDenied(partial),"unseekable stream must refuse");

bool Sequence(uint expected,uint actual) =>
    (bool)sequenceMethod.Invoke(null,new object[]{expected,actual})!;
Check(!Sequence(0,0)&&!Sequence(1,2)&&Sequence(2,2),
    "clipboard sequence must fail closed on unknown or later copy");

void Paste(string value,Func<uint> sequence,Action<string> write,
    Action<DataObject> restore,Action pasteAction,Func<IDataObject?>? read=null) =>
    pasteMethod.Invoke(null,new object?[]{value,read??(()=>synthetic),write,restore,sequence,pasteAction});
var writes=0;
var pasted=0;
var restored=0;
var clock=1u;
Paste("typed synthetic",()=>clock,_=>{writes++;clock++;},_=>restored++,()=>pasted++);
Check(writes==1&&pasted==1&&restored==1,"stable clipboard restores after exactly one temporary write");
writes=0;pasted=0;restored=0;clock=1;
Paste("typed synthetic",()=>clock,_=>{writes++;clock++;},_=>restored++,
    ()=>{pasted++;clock++;});
Check(writes==1&&pasted==1&&restored==0,"later user copy must not be overwritten");
writes=0;pasted=0;restored=0;clock=1;
try {
    Paste("typed synthetic",()=>clock++,_=>writes++ ,_=>restored++,()=>pasted++);
    failures.Add("pre-write sequence mismatch must refuse");
} catch(TargetInvocationException error) when(
    error.InnerException is InvalidOperationException exception &&
    exception.Message=="Clipboard cannot be preserved before typing.") {}
Check(writes==0&&pasted==0&&restored==0,"pre-write race must cause zero writes");
writes=0;pasted=0;restored=0;clock=1;
try {
    Paste("typed synthetic",()=>clock,_=>writes++, _=>restored++,()=>pasted++,
        ()=>partial); // partial.GetData returns unsupported object
    failures.Add("partial snapshot must refuse before clipboard write");
} catch(TargetInvocationException error) when(
    error.InnerException is InvalidOperationException exception &&
    exception.Message=="Clipboard cannot be preserved before typing.") {}
Check(writes==0&&pasted==0&&restored==0,"failed snapshot must cause zero writes");
writes=0;pasted=0;clock=1;
try {
    Paste("typed synthetic",()=>clock,_=>{writes++;clock++;},
        _=>throw new InvalidOperationException("synthetic private clipboard payload"),()=>pasted++);
    failures.Add("restore failure must be reported");
} catch(TargetInvocationException error) when(
    error.InnerException is InvalidOperationException exception &&
    exception.Message=="Clipboard could not be restored." &&
    exception.InnerException is null) {}
Check(writes==1&&pasted==1,"restore failure must not pretend that no paste occurred");

foreach(var failure in failures)Console.Error.WriteLine(failure);
Console.WriteLine($"Native root/token boundary assertions: {(failures.Count==0?"PASS":"FAIL")}");
return failures.Count==0?0:1;

internal sealed class SyntheticClipboardSource : IDataObject
{
    internal string[] Formats { get; set; } = [];
    internal Dictionary<string,object?> Values { get; } = new(StringComparer.OrdinalIgnoreCase);
    internal bool NullFormats { get; set; }
    internal bool ThrowOnFormats { get; set; }
    internal string? ThrowOnData { get; set; }
    public object? GetData(string format,bool autoConvert)
    {
        if(format==ThrowOnData) throw new InvalidOperationException("synthetic private clipboard payload");
        return Values.TryGetValue(format,out var value)?value:null;
    }
    public object? GetData(string format)=>GetData(format,false);
    public object? GetData(Type format)=>GetData(format.FullName??format.Name,false);
    public bool GetDataPresent(string format,bool autoConvert)=>Values.ContainsKey(format);
    public bool GetDataPresent(string format)=>GetDataPresent(format,false);
    public bool GetDataPresent(Type format)=>GetDataPresent(format.FullName??format.Name,false);
    public string[] GetFormats(bool autoConvert) =>
        ThrowOnFormats?throw new InvalidOperationException("synthetic private clipboard payload"):
        NullFormats?null!:Formats;
    public string[] GetFormats()=>GetFormats(false);
    public void SetData(string format,bool autoConvert,object data)=>Values[format]=data;
    public void SetData(string format,object data)=>SetData(format,false,data);
    public void SetData(Type format,object data)=>SetData(format.FullName??format.Name,false,data);
    public void SetData(object data)=>SetData(data.GetType(),data);
}

internal sealed class SyntheticUnseekableStream : MemoryStream
{
    public override bool CanSeek => false;
}
