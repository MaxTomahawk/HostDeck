using System.Reflection;
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
foreach(var failure in failures)Console.Error.WriteLine(failure);
Console.WriteLine($"Native root/token boundary assertions: {(failures.Count==0?"PASS":"FAIL")}");
return failures.Count==0?0:1;
