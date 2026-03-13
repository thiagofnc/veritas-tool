module adc_if (
    input wire clk,
    input wire rst,
    input wire enable,
    output reg sample_valid,
    output reg [11:0] sample_data
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            sample_valid <= 1'b0;
            sample_data <= 12'd0;
        end else begin
            sample_valid <= enable;
            sample_data <= sample_data + 12'd3;
        end
    end
endmodule
