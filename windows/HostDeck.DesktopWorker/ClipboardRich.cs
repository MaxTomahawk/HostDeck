using System.Collections.Specialized;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

namespace HostDeck.DesktopWorker;

internal static class ClipboardRich
{
    private const int MaxBytes = 16 * 1024 * 1024;

    internal static object Read(string format) => OnSta(() => format switch {
        "text" => new { format, text = Bounded(Clipboard.ContainsText() ? Clipboard.GetText() : "") } as object,
        "html" => new { format, html_text = Bounded(Clipboard.ContainsText(TextDataFormat.Html)
            ? Clipboard.GetText(TextDataFormat.Html) : "") },
        "image" => ReadImage(),
        "files" => new { format, files = Clipboard.ContainsFileDropList()
            ? Clipboard.GetFileDropList().Cast<string>().Take(1000).ToArray() : [] } as object,
        _ => throw new WorkerError("UNSUPPORTED_FORMAT")
    });

    private static object ReadImage()
    {
        if (!Clipboard.ContainsImage()) return new { format = "image", png_base64 = (string?)null, mime_type = "image/png" };
        using var image = Clipboard.GetImage();
        if (image is null || (long)image.Width * image.Height > 16_000_000)
            throw new WorkerError("CLIPBOARD_TOO_LARGE");
        using var stream = new MemoryStream();
        image.Save(stream, ImageFormat.Png);
        if (stream.Length > MaxBytes) throw new WorkerError("CLIPBOARD_TOO_LARGE");
        return new { format = "image", png_base64 = Convert.ToBase64String(stream.ToArray()), mime_type = "image/png" };
    }

    private static string Bounded(string value)
    {
        if (Encoding.UTF8.GetByteCount(value) > MaxBytes) throw new WorkerError("CLIPBOARD_TOO_LARGE");
        return value;
    }

    internal static object WriteArtifact(string format, string dataBase64)
    {
        if (dataBase64.Length > MaxBytes * 4 / 3 + 8) throw new WorkerError("CLIPBOARD_TOO_LARGE");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(dataBase64); }
        catch (FormatException) { throw new WorkerError("INVALID_ARGUMENTS"); }
        if (bytes.Length > MaxBytes) throw new WorkerError("CLIPBOARD_TOO_LARGE");
        return OnSta(() => {
            switch (format) {
                case "html":
                    var html = new UTF8Encoding(false, true).GetString(bytes);
                    var data = new DataObject();
                    data.SetText(html, TextDataFormat.Html);
                    Clipboard.SetDataObject(data, true);
                    break;
                case "image":
                    using (var stream = new MemoryStream(bytes))
                    using (var image = Image.FromStream(stream, true, true)) {
                        if ((long)image.Width * image.Height > 16_000_000)
                            throw new WorkerError("CLIPBOARD_TOO_LARGE");
                        using var bitmap = new Bitmap(image);
                        Clipboard.SetImage(bitmap);
                    }
                    break;
                case "files":
                    var files = JsonSerializer.Deserialize<string[]>(bytes)
                        ?? throw new WorkerError("INVALID_ARGUMENTS");
                    if (files.Length > 1000 || files.Any(f => !Path.IsPathFullyQualified(f) || f.Length > 4096))
                        throw new WorkerError("INVALID_ARGUMENTS");
                    var list = new StringCollection();
                    list.AddRange(files);
                    Clipboard.SetFileDropList(list);
                    break;
                default: throw new WorkerError("UNSUPPORTED_FORMAT");
            }
            return new { completed = true } as object;
        });
    }

    private static T OnSta<T>(Func<T> action)
    {
        T? result = default;
        Exception? error = null;
        var thread = new Thread(() => {
            try { result = action(); } catch (Exception ex) { error = ex; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (error is not null) throw error;
        return result!;
    }
}
