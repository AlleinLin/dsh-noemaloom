public class Main {
    static int doubled(int value) {
        int result = value * 2;
        return result;
    }
    public static void main(String[] args) {
        int input = 21;
        int answer = doubled(input);
        System.out.println("answer=" + answer);
    }
}
