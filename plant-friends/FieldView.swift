//
//  FieldView.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/19/22.
//

import SwiftUI

struct FieldView: View {
    var field: Field
    
    var body: some View {
        VStack(alignment: .leading) {
            Text(field.id)
                .bold()
            Spacer()
            ForEach(field.uses) { uses in

                    HStack(alignment: .center) {

                    Text(uses.name ?? "")
//                    LazyVGrid(columns: [
//                        GridItem(.adaptive(minimum: 50))
//                    ]) {
                        ScrollView(.horizontal) {
                            HStack{
                                
                        ForEach(uses.uses, id: \.self) { use in
                            Text(use)
                                .padding(.all, 3)

                                .background(Color.blue)
                                .foregroundColor(Color.white)
                                .cornerRadius(5)
                        }
                            }
//                    }
                }
                }
                
            }
            Text(field.text)
        }
    }
}

struct FieldView_Previews: PreviewProvider {
    static var previews: some View {
        Group {
            
            FieldView(field: PFAFPlant.sample.detailFields.first(where: {field in !field.uses.isEmpty}) ?? PFAFPlant.sample.detailFields[0])
        }
    }
}
