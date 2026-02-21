// Minimal test agent — matches exact pattern of working agents
using System;
using System.ComponentModel.Composition;
using Comos.Ai.Functions;
using Plt;

namespace Comos.TestTool.Agent
{
    [Export(typeof(AIComosTool))]
    public class TestToolAgent : AIComosTool
    {
        public string ToolScope { get { return "TestTool"; } }

        private static IComosDWorkset _workset;
        public static IComosDWorkset Workset { private get { return _workset; } set { _workset = value; } }

        [AiFunction("test_hello_world", "A simple test function that returns a greeting. Use this to verify the tool is registered.")]
        public object HelloWorld(
            [DescribeParameter("Name to greet", ExampleValue = "World")]
            string name)
        {
            return "Hello, " + (name ?? "World") + "! Test tool is active.";
        }
    }
}
