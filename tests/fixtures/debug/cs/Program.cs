class Program
{
    static int Doubled(int value)
    {
        int result = value * 2;
        return result;
    }
    static void Main()
    {
        int input = 21;
        int answer = Doubled(input);
        System.Console.WriteLine($"answer={answer}");
    }
}
