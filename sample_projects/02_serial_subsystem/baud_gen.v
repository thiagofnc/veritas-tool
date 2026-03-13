module baud_gen (
    input wire clk,
    input wire rst,
    output reg tick_16x
);
    reg [3:0] div_cnt;

    always @(posedge clk or posedge rst) begin
        if (rst) begin
            div_cnt <= 4'd0;
            tick_16x <= 1'b0;
        end else begin
            div_cnt <= div_cnt + 4'd1;
            tick_16x <= (div_cnt == 4'd15);
        end
    end
endmodule
