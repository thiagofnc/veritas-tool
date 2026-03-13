module i2c_master (
    input wire clk,
    input wire rst,
    input wire start,
    input wire [7:0] data_in,
    input wire sda_in,
    output reg scl,
    output reg sda_out,
    output reg [7:0] data_out,
    output reg done
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            scl <= 1'b1;
            sda_out <= 1'b1;
            data_out <= 8'd0;
            done <= 1'b0;
        end else begin
            scl <= ~clk;
            sda_out <= data_in[0];
            data_out <= {7'd0, sda_in};
            done <= start;
        end
    end
endmodule
