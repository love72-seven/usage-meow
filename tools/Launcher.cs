using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("用量喵快捷入口")]
[assembly: AssemblyDescription("直接启动已安装的用量喵，不进行解压")]
[assembly: AssemblyVersion("0.1.1.0")]

internal static class Launcher
{
    [STAThread]
    private static int Main(string[] args)
    {
        string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
#if UNINSTALL
        string target = Path.Combine(root, "app", "Uninstall 用量喵.exe");
        string action = "卸载";
#else
        string target = Path.Combine(root, "app", "用量喵.exe");
        string action = "启动";
#endif
        // Verification never starts the program or triggers uninstallation.
        if (args.Length == 1 && args[0] == "--verify-target")
            return File.Exists(target) ? 0 : 1;

        if (!File.Exists(target))
        {
            MessageBox.Show("找不到已安装的程序：\n" + target +
                "\n\n请使用 dist 中的安装包安装，或在实际安装目录运行程序。",
                "用量喵", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(target);
            info.WorkingDirectory = Path.GetDirectoryName(target);
            info.UseShellExecute = false;
            info.Arguments = String.Join(" ", Array.ConvertAll(args, QuoteArgument));
            using (Process child = Process.Start(info))
            {
                // A diagnostic caller needs the actual application's result.
                if (Array.IndexOf(args, "--smoke-test") >= 0)
                {
                    child.WaitForExit();
                    return child.ExitCode;
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(action + "失败：" + error.Message, "用量喵",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    // Preserve argument boundaries using the Windows CommandLineToArgvW rules.
    private static string QuoteArgument(string value)
    {
        StringBuilder output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"')
                output.Append('\\', slashes * 2 + 1);
            else
                output.Append('\\', slashes);
            output.Append(character);
            slashes = 0;
        }
        output.Append('\\', slashes * 2);
        output.Append('"');
        return output.ToString();
    }
}
